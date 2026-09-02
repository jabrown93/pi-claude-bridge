import type { Skill } from "@earendil-works/pi-coding-agent";
import { formatProjectContext } from "./agents-md.js";
import { renderSkillsBlock, type SkillReadTool } from "./skills.js";

// What pi assembled for one agent, kept so the bridge can append only the
// portable parts after Claude Code's own preset.

export type PromptCaptureInput = {
	custom?: string;
	append?: string;
	contextFiles: { path: string; content: string }[];
	skills: Skill[];
};

type InheritedPrompt = {
	start: number;
	end: number;
	parent: PromptCapture;
};

export type PromptCapture = PromptCaptureInput & {
	assembledPrompt: string;
	/** Exact previously assembled prompts embedded in `custom`. */
	inherited: InheritedPrompt[];
};

/**
 * Captures keyed by the fully assembled prompt pi sends to a provider.
 *
 * A sub-agent's systemPromptOverride embeds its parent's assembled prompt
 * verbatim. Pi currently exposes that override as an ordinary custom prompt,
 * without provenance. Linking exact prior keys recovers the inheritance graph
 * without recognizing pi prose or sub-agent markers. If pi later exposes an
 * inherited-system-prompt field, it should replace this inference.
 */
export type PromptCaptureDiagnostic = {
	/** The prompt that matched nothing: the full system prompt is too big to log
	 *  inline, so a fingerprint plus the closest match's first divergent offset
	 *  are enough to recognize the pump.
	 *
	 *  Closest is by shared prefix — the case that matters here is pi itself
	 *  rebuilding the prompt outside `before_agent_start` (a changed tool list or
	 *  fresh resource discovery), which edits near the boundary, and a prefix key
	 *  gets us to within a handful of characters of where. */
	systemPrompt: string;
	matches: { key: string; firstDivergent: number }[];
};

export type PromptRecoverDiagnostic = {
	/** The rebuilt prompt that matched no key exactly and embedded none, but whose
	 *  churn-invariant identifying core was found verbatim, so the agent's recorded
	 *  parts were reused instead of failing the turn. Surfaced because those parts can
	 *  lag the rebuild by one before_agent_start (skills rediscovered after capture). */
	systemPrompt: string;
	anchorKind: string;
	anchorLength: number;
	contextFiles: string[];
	skillCount: number;
};

/** Below this, an anchor is too short to prove agent identity on its own and is
 *  ignored — recovery must not hang an agent's whole context on a coincidental
 *  substring. Pi's <project_context> block clears this even when nearly empty. */
const MIN_ANCHOR_CHARS = 64;

export class PromptCaptures {
	private readonly captures = new Map<string, PromptCapture>();
	/** Invoked with everything that would otherwise be lost when resolution throws,
	 *  so the bridge can write it to its debug log. Kept off the throw path itself:
	 *  the resolver is hot and the caller may own a faster sink than string-building.
	 *
	 *  Set by the bridge on the shared instance; tests that want the diagnostic can
	 *  pass one per instance. */
	private readonly onDiagnose: (diagnostic: PromptCaptureDiagnostic) => void;
	/** Invoked when a rebuilt prompt is recovered by its stable anchor rather than
	 *  throwing. The recovered parts can lag the current turn by one before_agent_start,
	 *  so the event is surfaced, never silent. Set by the bridge on the shared instance. */
	private readonly onRecover: (diagnostic: PromptRecoverDiagnostic) => void;

	/** Pi rebuilds prompts when tools change, so retain only recent lookup keys.
	 *  Inheritance edges hold direct references and survive key eviction.
	 *
	 *  Set well above any plausible working set because the costs are lopsided: a
	 *  capture is tens of KB, while evicting one that is still live fails the turn.
	 *  A parent that fans out to more distinct sub-agent prompts than this before its
	 *  own next turn would be evicted despite being in use. The bound exists only to
	 *  cap an extension that rebuilds the prompt every turn, which would otherwise
	 *  grow keys without limit. */
	constructor(
		private readonly limit = 256,
		onDiagnose?: (diagnostic: PromptCaptureDiagnostic) => void,
		onRecover?: (diagnostic: PromptRecoverDiagnostic) => void,
	) {
		this.onDiagnose = onDiagnose ?? (() => {});
		this.onRecover = onRecover ?? (() => {});
	}

	record(systemPrompt: string, input: PromptCaptureInput): void {
		const existing = this.captures.get(systemPrompt);
		const customChanged = existing?.custom !== input.custom;
		const capture = existing ?? {
			...input,
			assembledPrompt: systemPrompt,
			contextFiles: [],
			skills: [],
			inherited: [],
		};

		capture.custom = input.custom;
		capture.append = input.append;
		capture.contextFiles = input.contextFiles.map((file) => ({ ...file }));
		capture.skills = [...input.skills];
		if (!existing || customChanged) {
			capture.inherited = this.findInheritedPrompts(systemPrompt, input.custom);
		}

		// Mutate an existing node in place so descendants retain a live reference,
		// then re-insert its key so Map order tracks recency.
		this.touch(systemPrompt, capture);
	}

	/** Exact lookup only. Callers serving a query want `resolveOrDerive`. */
	resolve(systemPrompt?: string): PromptCapture | undefined {
		if (!systemPrompt) return undefined;
		const capture = this.captures.get(systemPrompt);
		if (capture) this.touch(systemPrompt, capture);
		return capture;
	}

	/** Recency is by use, not just by record. A parent agent records its prompt once
	 *  and then only ever resolves it, so counting writes alone ages it out behind the
	 *  sub-agent prompts churning past it — observed in a real 135-message session,
	 *  where the parent's own prompt was evicted and its next turn resolved to
	 *  nothing. */
	private touch(systemPrompt: string, capture: PromptCapture): void {
		this.captures.delete(systemPrompt);
		this.captures.set(systemPrompt, capture);
		// Trims here, not only in record(): reviving an evicted node re-adds a key that
		// was not in the map, so without this a run of revivals grows it without bound.
		for (const key of this.captures.keys()) {
			if (this.captures.size <= this.limit) break;
			this.captures.delete(key);
		}
	}

	/**
	 * The capture to project for one query, for both the provider and AskClaude.
	 *
	 * An exact key is the normal case. A prompt that only *embeds* known prompts —
	 * anything that wrapped what Pi assembled after we recorded it — resolves to a
	 * transient descendant over the whole prompt, so projection swaps each embedded
	 * capture for its portable parts and carries everything around them through
	 * unchanged. That surrounding text belongs to whatever did the wrapping, and
	 * dropping it would be exactly the silent instruction loss this exists to
	 * prevent. The descendant is not retained — its key is not ours to own.
	 *
	 * A prompt that matches neither exactly nor by embedding, yet carries an agent's
	 * churn-invariant identifying core verbatim — its <project_context> block, its
	 * custom/replace prompt (or, for a sub-agent, its own slices of that prompt), or a
	 * stable append — is one pi rebuilt outside before_agent_start (fresh
	 * skill/resource discovery, a late-registered tool). Recovery reuses that agent's
	 * recorded parts rather than failing the turn; the recovered skills may lag the
	 * rebuild by one before_agent_start, so the recovery is surfaced through onRecover.
	 *
	 * Throws when a prompt can be accounted for by none of these routes. Returning an empty
	 * capture instead would hand Claude Code a turn with none of the user's context
	 * files, skills, custom prompt or append text, and say so only in a debug line —
	 * silently discarding policy the user wrote down. A failed turn is recoverable;
	 * a turn that quietly ignored its instructions is not.
	 */
	resolveOrDerive(systemPrompt?: string): PromptCapture | undefined {
		if (!systemPrompt) return undefined;
		const exact = this.captures.get(systemPrompt);
		if (exact) {
			this.touch(systemPrompt, exact);
			return exact;
		}

		// A capture outlives its lookup key: eviction drops the key while inheritance
		// edges keep the node alive. findInheritedPrompts deliberately skips a node whose
		// key *is* the prompt, so without this an evicted exact match would derive
		// nothing and throw. Touching it puts the key back.
		const revived = this.reachableCaptures().find((node) => node.assembledPrompt === systemPrompt);
		if (revived) {
			this.touch(systemPrompt, revived);
			return revived;
		}

		const embedded = this.findInheritedPrompts(systemPrompt, systemPrompt);
		if (embedded.length === 0) {
			// Third route: pi rebuilt the prompt outside before_agent_start (fresh skill or
			// resource discovery rewrites the skills section; a late-registered tool rewrites
			// the tools list), so it is neither an exact key nor embeds one. The rebuild never
			// touches an agent's identifying core — its <project_context> block or custom/replace
			// prompt — so a verbatim match there recovers the agent's own recorded parts. Safe
			// because a different agent's core is never a verbatim substring; the cost is skills
			// that may lag by one before_agent_start, which the next capture corrects.
			const recovered = this.recoverByStableAnchor(systemPrompt);
			if (recovered) {
				this.onRecover({
					systemPrompt,
					anchorKind: recovered.anchorKind,
					anchorLength: recovered.anchorLength,
					contextFiles: recovered.capture.contextFiles.map((file) => file.path),
					skillCount: recovered.capture.skills.length,
				});
				// Keep the still-live node warm; the rebuilt prompt is not a key we own, so it is
				// not recorded — the next before_agent_start re-records the fresh parts.
				this.touch(recovered.capture.assembledPrompt, recovered.capture);
				return recovered.capture;
			}

			const matches = this.closestKnown(systemPrompt);
			this.onDiagnose({ systemPrompt, matches });
			throw new Error(
				`prompt-capture: no capture for this ${systemPrompt.length}-char system prompt, and it embeds none of the ${this.captures.size} known. `
				+ `Closest known match diverges at offset ${matches[0]?.firstDivergent ?? "?"} (${matches.length ? matches[0].key.length : 0}-char key). `
				+ `Claude Code would receive none of this turn's context files, skills or custom instructions. `
				+ `The usual cause is an extension loaded after claude-bridge that rewrites the system prompt from before_agent_start — `
				+ `one that wraps it is fine, one that rebuilds or strips it leaves nothing to match. `
				+ `(Also possible: pi rebuilt the prompt outside before_agent_start — a late-registered tool or fresh resource discovery.)`,
			);
		}

		// `custom` is the prompt itself and the edges keep their original offsets, so
		// projectCustom substitutes the embedded captures in place and preserves every
		// byte between and around them.
		return { assembledPrompt: systemPrompt, custom: systemPrompt, contextFiles: [], skills: [], inherited: embedded };
	}

	/** Recover a rebuilt prompt by a churn-invariant substring pi embeds verbatim that
	 *  uniquely identifies an agent (see stableAnchors). Returns the recorded parts of
	 *  the best match, or undefined when nothing anchors so the caller throws as before.
	 *
	 *  A sub-agent's override embeds its parent verbatim, so a parent's anchors also
	 *  appear in the child's prompt. Ranking by anchor length alone would then return
	 *  the parent and silently drop the child's role. The most specific matching node —
	 *  the longest recorded assembledPrompt — is the agent itself: a genuine parent send
	 *  never contains a child (children are not embedded upward), so only the true owner
	 *  and its ancestors match, and the owner is the longest. */
	private recoverByStableAnchor(
		systemPrompt: string,
	): { capture: PromptCapture; anchorKind: string; anchorLength: number } | undefined {
		let best: { capture: PromptCapture; anchorKind: string; anchorLength: number } | undefined;
		for (const node of this.reachableCaptures()) {
			if (node.assembledPrompt === systemPrompt) continue;
			let match: { kind: string; length: number } | undefined;
			for (const { kind, text } of this.stableAnchors(node)) {
				if (match && text.length <= match.length) continue;
				if (systemPrompt.includes(text)) match = { kind, length: text.length };
			}
			if (!match) continue;
			const moreSpecific = !best
				|| node.assembledPrompt.length > best.capture.assembledPrompt.length
				|| (node.assembledPrompt.length === best.capture.assembledPrompt.length && match.length > best.anchorLength);
			if (moreSpecific) best = { capture: node, anchorKind: match.kind, anchorLength: match.length };
		}
		return best;
	}

	/** Churn-invariant substrings pi embeds verbatim that identify one agent. Tool-list,
	 *  skill-list, and refinement-overlay churn edit none of them:
	 *   - project_context: the agent's <project_context> (AGENTS.md) block, which
	 *     formatProjectContext reproduces byte-for-byte, so the test is exact not fuzzy;
	 *   - custom: a replace/override prompt in full — also a sub-agent's parent-embedding
	 *     override when its embedded parent has not itself been rebuilt;
	 *   - custom_slice: for a sub-agent, the runs of its override outside the embedded
	 *     parent regions — its own <sub_agent_context>/<agent_instructions>, which survive
	 *     a rebuilt parent that shifts the whole-custom match;
	 *   - append: a stable appendSystemPrompt when nothing else anchors.
	 *  Below MIN_ANCHOR_CHARS a substring cannot prove identity on its own and is dropped. */
	private stableAnchors(node: PromptCapture): { kind: string; text: string }[] {
		const anchors: { kind: string; text: string }[] = [];
		const push = (kind: string, text: string | undefined): void => {
			if (text && text.length >= MIN_ANCHOR_CHARS) anchors.push({ kind, text });
		};
		push("project_context", formatProjectContext(node.contextFiles));
		push("custom", node.custom);
		for (const slice of outsideInheritedSlices(node)) push("custom_slice", slice);
		push("append", node.append);
		return anchors;
	}

	get size(): number {
		return this.captures.size;
	}

	/** Longest shared-prefix matches, best first, for the throw diagnostic. */
	private closestKnown(systemPrompt: string): { key: string; firstDivergent: number }[] {
		let shared = 0;
		const matches: { key: string; firstDivergent: number }[] = [];
		for (const key of this.captures.keys()) {
			const limit = Math.min(key.length, systemPrompt.length);
			let i = 0;
			while (i < limit && key.charCodeAt(i) === systemPrompt.charCodeAt(i)) i++;
			if (i >= shared) {
				if (i > shared) {
					shared = i;
					matches.length = 0;
				}
				matches.push({ key, firstDivergent: i });
			}
		}
		return matches;
	}

	private findInheritedPrompts(systemPrompt: string, custom?: string): InheritedPrompt[] {
		if (!custom) return [];

		const candidates: Array<InheritedPrompt & { length: number }> = [];
		for (const parent of this.reachableCaptures()) {
			const key = parent.assembledPrompt;
			if (key === systemPrompt || key.length === 0) continue;
			for (let start = custom.indexOf(key); start !== -1; start = custom.indexOf(key, start + key.length)) {
				candidates.push({ start, end: start + key.length, length: key.length, parent });
			}
		}

		// A grandchild contains both its parent's key and the grandparent key
		// nested inside it. Keep the longest exact non-overlapping matches.
		candidates.sort((a, b) => b.length - a.length || a.start - b.start);
		const selected: InheritedPrompt[] = [];
		for (const candidate of candidates) {
			if (selected.some((edge) => candidate.start < edge.end && candidate.end > edge.start)) continue;
			selected.push({ start: candidate.start, end: candidate.end, parent: candidate.parent });
		}
		return selected.sort((a, b) => a.start - b.start);
	}

	private reachableCaptures(): PromptCapture[] {
		const result: PromptCapture[] = [];
		const seen = new Set<PromptCapture>();
		const visit = (capture: PromptCapture): void => {
			if (seen.has(capture)) return;
			seen.add(capture);
			result.push(capture);
			for (const edge of capture.inherited) visit(edge.parent);
		};
		for (const capture of this.captures.values()) visit(capture);
		return result;
	}
}

/** The runs of `custom` not covered by an inherited (embedded-parent) edge: a
 *  sub-agent's own instructions, which survive a rebuilt parent embed that shifts the
 *  whole-`custom` match. Empty when there are no edges — whole `custom` covers that. */
function outsideInheritedSlices(node: PromptCapture): string[] {
	if (!node.custom || node.inherited.length === 0) return [];
	const edges = [...node.inherited].sort((a, b) => a.start - b.start);
	const slices: string[] = [];
	let cursor = 0;
	for (const edge of edges) {
		if (edge.start > cursor) slices.push(node.custom.slice(cursor, edge.start));
		cursor = Math.max(cursor, edge.end);
	}
	if (cursor < node.custom.length) slices.push(node.custom.slice(cursor));
	return slices;
}

export function projectPromptCapture(
	capture: PromptCapture,
	options: { skillReadTool: SkillReadTool },
): string | undefined {
	return projectCapture(capture, options, new Set());
}

/** Skills visible through inherited prompts, ancestor first and once per file. */
export function collectPromptSkills(capture: PromptCapture): Skill[] {
	const result: Skill[] = [];
	const seenPaths = new Set<string>();
	const visited = new Set<PromptCapture>();
	const visiting = new Set<PromptCapture>();

	const visit = (node: PromptCapture): void => {
		if (visited.has(node)) return;
		if (visiting.has(node)) throw new Error("Cyclic prompt inheritance");
		visiting.add(node);
		for (const edge of node.inherited) visit(edge.parent);
		for (const skill of node.skills) {
			if (skill.disableModelInvocation || seenPaths.has(skill.filePath)) continue;
			seenPaths.add(skill.filePath);
			result.push(skill);
		}
		visiting.delete(node);
		visited.add(node);
	};

	visit(capture);
	return result;
}

function projectCapture(
	capture: PromptCapture,
	options: { skillReadTool: SkillReadTool },
	visiting: Set<PromptCapture>,
): string | undefined {
	if (visiting.has(capture)) throw new Error("Cyclic prompt inheritance");
	visiting.add(capture);
	try {
		const inheritedSkillPaths = new Set(
			capture.inherited.flatMap((edge) => collectPromptSkills(edge.parent).map((skill) => skill.filePath)),
		);
		const ownSkillPaths = new Set<string>();
		const ownSkills = capture.skills.filter((skill) => {
			if (skill.disableModelInvocation || inheritedSkillPaths.has(skill.filePath) || ownSkillPaths.has(skill.filePath)) {
				return false;
			}
			ownSkillPaths.add(skill.filePath);
			return true;
		});

		const custom = projectCustom(capture, options, visiting);
		const parts = [
			formatProjectContext(capture.contextFiles),
			renderSkillsBlock(ownSkills, options.skillReadTool),
			custom,
			capture.append,
		].filter((part): part is string => Boolean(part));
		return parts.length > 0 ? parts.join("\n\n") : undefined;
	} finally {
		visiting.delete(capture);
	}
}

function projectCustom(
	capture: PromptCapture,
	options: { skillReadTool: SkillReadTool },
	visiting: Set<PromptCapture>,
): string | undefined {
	if (!capture.custom || capture.inherited.length === 0) return capture.custom;

	let result = "";
	let cursor = 0;
	for (const edge of capture.inherited) {
		result += capture.custom.slice(cursor, edge.start);
		result += projectCapture(edge.parent, options, visiting) ?? "";
		cursor = edge.end;
	}
	return result + capture.custom.slice(cursor);
}
