interface ScriptSnapshot {
	instancePath: string;
	name: string;
	className: string;
	enabled?: boolean;
	source: string;
}

interface ScriptCorpus {
	resolveRoot(path: string): Instance | undefined;
	getChildren(instance: Instance): Instance[];
	readScript(instance: Instance, classFilter?: string): ScriptSnapshot | undefined;
}

interface SearchControl {
	checkpoint(): void;
}

interface LineMatch {
	line: number;
	column: number;
	text: string;
	before: string[];
	after: string[];
}

interface ScriptResult {
	instancePath: string;
	name: string;
	className: string;
	enabled?: boolean;
	matches: LineMatch[];
}

function splitLuaAlternation(pattern: string): string[] {
	const parts: string[] = [];
	let current = "";
	let index = 1;
	let inCharacterClass = false;
	while (index <= pattern.size()) {
		const character = string.sub(pattern, index, index);
		if (character === "%") {
			if (string.sub(pattern, index + 1, index + 1) === "b") {
				current += string.sub(pattern, index, math.min(index + 3, pattern.size()));
				index += 4;
			} else {
				current += string.sub(pattern, index, index + 1);
				index += 2;
			}
		} else if (character === "[") {
			inCharacterClass = true;
			current += character;
			index++;
		} else if (character === "]") {
			inCharacterClass = false;
			current += character;
			index++;
		} else if (character === "|" && !inCharacterClass) {
			parts.push(current);
			current = "";
			index++;
		} else {
			current += character;
			index++;
		}
	}
	parts.push(current);
	return parts;
}

function findFirstPattern(
	line: string,
	alternatives: string[],
	control: SearchControl,
): number | undefined {
	let earliest: number | undefined;
	for (const alternative of alternatives) {
		control.checkpoint();
		if (alternative === "") continue;
		const [start] = string.find(line, alternative);
		if (start !== undefined && (earliest === undefined || start < earliest)) earliest = start;
	}
	return earliest;
}

function readLine(source: string, start: number): [string, number | undefined] {
	const [boundary] = string.find(source, "[\r\n]", start);
	if (boundary === undefined) return [string.sub(source, start), undefined];

	let nextStart = boundary + 1;
	if (
		string.sub(source, boundary, boundary) === "\r" &&
		string.sub(source, nextStart, nextStart) === "\n"
	) {
		nextStart++;
	}
	return [
		string.sub(source, start, boundary - 1),
		nextStart <= source.size() ? nextStart : undefined,
	];
}

const MAX_RESULTS = 10_000;
const LITERAL_CHUNK_BYTES = 64 * 1024;
const MAX_PATTERN_BYTES = 4096;

const MAX_CONTEXT_LINES = 100;

function sourceCanMatchLiteral(
	source: string,
	pattern: string,
	caseSensitive: boolean,
	control: SearchControl,
): boolean {
	if (source.size() === 0) return false;

	const overlapBytes = math.max(pattern.size() - 1, 0);
	let chunkStart = 1;
	while (chunkStart <= source.size()) {
		control.checkpoint();
		const chunkEnd = math.min(
			source.size(),
			chunkStart + LITERAL_CHUNK_BYTES + overlapBytes - 1,
		);
		const chunk = string.sub(source, chunkStart, chunkEnd);
		const candidate = caseSensitive ? chunk : chunk.lower();
		if (string.find(candidate, pattern, 1, true)[0] !== undefined) return true;
		if (chunkEnd >= source.size()) return false;
		chunkStart += LITERAL_CHUNK_BYTES;
	}
	return false;
}

function createScriptSearch(corpus: ScriptCorpus) {
	function search(requestData: Record<string, unknown>, control: SearchControl): Record<string, unknown> {
		const requestedPattern = requestData.pattern;
		if (!typeIs(requestedPattern, "string") || requestedPattern === "") {
			return { error: "pattern is required" };
		}
		if (requestedPattern.size() > MAX_PATTERN_BYTES) {
			return {
				error: "invalid_request",
				message: `pattern must contain between 1 and ${MAX_PATTERN_BYTES} bytes`,
			};
		}
		const pattern = requestedPattern;

		for (const optionName of ["usePattern", "caseSensitive", "filesOnly"]) {
			const option = requestData[optionName];
			if (option !== undefined && !typeIs(option, "boolean")) {
				return {
					error: "invalid_request",
					message: `${optionName} must be a boolean`,
				};
			}
		}
		const usePattern = (requestData.usePattern as boolean) ?? false;
		if (usePattern && requestData.caseSensitive === false) {
			return { error: "Case-insensitive Lua pattern search is not supported." };
		}
		const caseSensitive = usePattern ? true : ((requestData.caseSensitive as boolean) ?? false);
		const filesOnly = (requestData.filesOnly as boolean) ?? false;
		const requestedContextLines = requestData.contextLines;
		if (
			requestedContextLines !== undefined &&
			(
				!typeIs(requestedContextLines, "number") ||
				math.floor(requestedContextLines) !== requestedContextLines ||
				requestedContextLines < 0 ||
				requestedContextLines > MAX_CONTEXT_LINES
			)
		) {
			return {
				error: "invalid_request",
				message: `contextLines must be an integer between 0 and ${MAX_CONTEXT_LINES}`,
			};
		}
		const contextLines = (requestedContextLines as number | undefined) ?? 0;
		const requestedMaxResults = requestData.maxResults;
		if (
			requestedMaxResults !== undefined &&
			(
				!typeIs(requestedMaxResults, "number") ||
				math.floor(requestedMaxResults) !== requestedMaxResults ||
				requestedMaxResults < 1 ||
				requestedMaxResults > MAX_RESULTS
			)
		) {
			return {
				error: "invalid_request",
				message: `maxResults must be an integer between 1 and ${MAX_RESULTS}`,
			};
		}
		const maxResults = (requestedMaxResults as number | undefined) ?? 100;
		const requestedMaxResultsPerScript = requestData.maxResultsPerScript;
		if (
			requestedMaxResultsPerScript !== undefined &&
			(
				!typeIs(requestedMaxResultsPerScript, "number") ||
				math.floor(requestedMaxResultsPerScript) !== requestedMaxResultsPerScript ||
				requestedMaxResultsPerScript < 0 ||
				requestedMaxResultsPerScript > MAX_RESULTS
			)
		) {
			return {
				error: "invalid_request",
				message: `maxResultsPerScript must be an integer between 0 and ${MAX_RESULTS}`,
			};
		}
		const maxResultsPerScript = (requestedMaxResultsPerScript as number | undefined) ?? 0;
		const classFilter = requestData.classFilter as string | undefined;
		const searchPath = (requestData.path as string) ?? "";
		const root = corpus.resolveRoot(searchPath);
		if (root === undefined) return { error: `Path not found: ${searchPath}` };

		const searchPattern = caseSensitive ? pattern : pattern.lower();
		const patternAlternatives = usePattern ? splitLuaAlternation(searchPattern) : undefined;
		const results: ScriptResult[] = [];
		const stack: Instance[] = [root];
		let totalMatches = 0;
		let scriptsSearched = 0;
		let hitLimit = false;

		while (stack.size() > 0 && !hitLimit) {
			control.checkpoint();
			const instance = stack.pop()!;
			const snapshot = corpus.readScript(instance, classFilter);
			if (snapshot !== undefined && (classFilter === undefined || snapshot.className === classFilter)) {
				scriptsSearched++;
				const scriptMatches: LineMatch[] = [];
				// Head-index queues: Array.shift() is O(n) (table.remove at 1);
				// advancing a head cursor keeps per-line work O(1).
				const before: string[] = [];
				let beforeHead = 0;
				const pendingAfter: { match: LineMatch; remaining: number }[] = [];
				let pendingHead = 0;
				let scriptMatchCount = 0;
				let lineNumber = 1;
				let lineStart: number | undefined = 1;

				const canMatch = usePattern || sourceCanMatchLiteral(
					snapshot.source,
					searchPattern,
					caseSensitive,
					control,
				);
				if (canMatch) {
				while (lineStart !== undefined && !hitLimit) {
					control.checkpoint();
					const [line, nextLineStart] = readLine(snapshot.source, lineStart);

					if (pendingHead < pendingAfter.size()) {
						for (let pendingIndex = pendingHead; pendingIndex < pendingAfter.size(); pendingIndex++) {
							const pending = pendingAfter[pendingIndex];
							if (pending.remaining > 0) {
								pending.match.after.push(line);
								pending.remaining--;
							}
						}
						while (pendingHead < pendingAfter.size() && pendingAfter[pendingHead].remaining === 0) {
							pendingHead++;
						}
						if (pendingHead > 64 && pendingHead * 2 >= pendingAfter.size()) {
							const liveCount = pendingAfter.size() - pendingHead;
							for (let i = 0; i < liveCount; i++) {
								pendingAfter[i] = pendingAfter[i + pendingHead];
							}
							for (let i = 0; i < pendingHead; i++) {
								pendingAfter.pop();
							}
							pendingHead = 0;
						}
					}

					let matchStart: number | undefined;
					if (usePattern) {
						matchStart = findFirstPattern(line, patternAlternatives!, control);
					} else if (caseSensitive) {
						matchStart = string.find(line, searchPattern, 1, true)[0];
					} else if (line.size() >= searchPattern.size()) {
						// string.lower preserves byte length for the ASCII sources
						// this search targets, so lines shorter than the pattern
						// can never match. Skipping lower() avoids one
						// allocation per short line.
						matchStart = string.find(line.lower(), searchPattern, 1, true)[0];
					} else {
						matchStart = undefined;
					}
					if (
						matchStart !== undefined &&
						(maxResultsPerScript === 0 || scriptMatchCount < maxResultsPerScript)
					) {
						scriptMatchCount++;
						totalMatches++;
						if (totalMatches > maxResults) {
							hitLimit = true;
							break;
						}
						if (!filesOnly) {
							let beforeContext: string[];
							if (contextLines > 0 && before.size() - beforeHead > 0) {
								beforeContext = [];
								for (let i = beforeHead; i < before.size(); i++) {
									beforeContext.push(before[i]);
								}
							} else {
								beforeContext = [];
							}
							const lineMatch: LineMatch = {
								line: lineNumber,
								column: matchStart,
								text: line,
								before: beforeContext,
								after: [],
							};
							scriptMatches.push(lineMatch);
							if (contextLines > 0) {
								pendingAfter.push({ match: lineMatch, remaining: contextLines });
							}
						}
					}
					if (
						maxResultsPerScript > 0 &&
						scriptMatchCount >= maxResultsPerScript &&
						pendingHead >= pendingAfter.size()
					) {
						break;
					}

					if (contextLines > 0) {
						before.push(line);
						if (before.size() - beforeHead > contextLines) {
							beforeHead++;
						}
						if (beforeHead > 1024 && beforeHead * 2 > before.size()) {
							const liveCount = before.size() - beforeHead;
							for (let i = 0; i < liveCount; i++) {
								before[i] = before[i + beforeHead];
							}
							for (let i = 0; i < beforeHead; i++) {
								before.pop();
							}
							beforeHead = 0;
						}
					}
					lineStart = nextLineStart;
					if (nextLineStart === undefined) break;
					lineNumber++;
				}
				}

				if (scriptMatchCount > 0) {
					const scriptResult: ScriptResult = {
						instancePath: snapshot.instancePath,
						name: snapshot.name,
						className: snapshot.className,
						matches: scriptMatches,
					};
					if (snapshot.enabled !== undefined) scriptResult.enabled = snapshot.enabled;
					results.push(scriptResult);
				}
			}

			// Push children in reverse so pop() visits them in order.
			// Corpus arrays cross the VM boundary and lack Luau .size(),
			// so copy them into a VM-local array before indexing.
			const children: Instance[] = [];
			for (const child of corpus.getChildren(instance)) children.push(child);
			for (let index = children.size() - 1; index >= 0; index--) stack.push(children[index]);
		}

		return {
			results,
			pattern,
			totalMatches: hitLimit ? `>${maxResults}` : totalMatches,
			scriptsSearched,
			scriptsMatched: results.size(),
			truncated: hitLimit,
			options: {
				caseSensitive,
				contextLines,
				usePattern,
				filesOnly,
				maxResults,
				maxResultsPerScript,
			},
		};
	}

	return { search };
}

export = {
	createScriptSearch,
};
