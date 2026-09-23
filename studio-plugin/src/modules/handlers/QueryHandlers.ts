import Utils from "../Utils";
import CooperativeJobRunner from "../CooperativeJobRunner";
import ScriptSearch from "../ScriptSearch";
import type { StudioRequestContext } from "../../types";

const { getInstancePath, getInstanceByPath, readScriptSource } = Utils;

function getPlaceInfo(_requestData: Record<string, unknown>) {
	const dataModelName = game.Name;
	let placeName = dataModelName;

	if (game.PlaceId > 0) {
		const MarketplaceService = game.GetService("MarketplaceService");
		const [ok, info] = pcall(() => MarketplaceService.GetProductInfo(game.PlaceId));
		if (ok && info !== undefined) {
			const name = (info as { Name?: string }).Name;
			if (typeIs(name, "string") && name !== "") {
				placeName = name;
			}
		}
	}

	return {
		placeName,
		dataModelName,
		placeId: game.PlaceId,
		gameId: game.GameId,
		jobId: game.JobId,
		workspace: {
			name: game.Workspace.Name,
			className: game.Workspace.ClassName,
		},
	};
}

function searchObjects(requestData: Record<string, unknown>) {
	const query = requestData.query as string;
	const searchType = (requestData.searchType as string) ?? "name";
	const propertyName = requestData.propertyName as string | undefined;
	const rootPath = requestData.root as string | undefined;
	const limit = math.clamp(math.floor((requestData.limit as number | undefined) ?? 50), 1, 1000);

	if (!query) return { error: "Query is required" };
	if (searchType === "property" && !propertyName) return { error: "propertyName is required when searchType is property" };

	const root = rootPath !== undefined && rootPath !== "" ? getInstanceByPath(rootPath) : game;
	if (!root) return { error: `Instance not found: ${rootPath}` };

	// Plain (non-pattern) matching: queries like "a.b" or "(" are literal text.
	const needle = query.lower();
	const matches = (text: string) => text.lower().find(needle, 1, true)[0] !== undefined;

	const results: { name: string; className: string; path: string }[] = [];
	let truncated = false;
	for (const instance of root.GetDescendants()) {
		let match = false;
		if (searchType === "name") {
			match = matches(instance.Name);
		} else if (searchType === "class") {
			match = matches(instance.ClassName);
		} else if (searchType === "property") {
			const [success, value] = pcall(() => tostring((instance as unknown as Record<string, unknown>)[propertyName!]));
			match = success && matches(value as string);
		}
		if (!match) continue;
		if (results.size() >= limit) {
			truncated = true;
			break;
		}
		results.push({ name: instance.Name, className: instance.ClassName, path: getInstancePath(instance) });
	}

	return { results, count: results.size(), truncated };
}

function getInstanceProperties(requestData: Record<string, unknown>) {
	const instancePath = requestData.instancePath as string;
	const excludeSource = (requestData.excludeSource as boolean) ?? false;
	if (!instancePath) return { error: "Instance path is required" };

	const instance = getInstanceByPath(instancePath);
	if (!instance) return { error: `Instance not found: ${instancePath}` };

	const properties: Record<string, unknown> = {};
	const [success, result] = pcall(() => {
		const basicProps = ["Name", "ClassName", "Parent"];
		for (const prop of basicProps) {
			const [propSuccess, propValue] = pcall(() => {
				const val = (instance as unknown as Record<string, unknown>)[prop];
				if (prop === "Parent" && val) return getInstancePath(val as Instance);
				if (val === undefined) return "nil";
				return tostring(val);
			});
			if (propSuccess) properties[prop] = propValue;
		}

		const commonProps = [
			"Size", "Position", "Rotation", "CFrame", "Anchored", "CanCollide",
			"Transparency", "BrickColor", "Material", "Color", "Text", "TextColor3",
			"BackgroundColor3", "Image", "ImageColor3", "Visible", "Active", "ZIndex",
			"BorderSizePixel", "BackgroundTransparency", "ImageTransparency",
			"TextTransparency", "Value", "Enabled", "Brightness", "Range", "Shadows",
			"Face", "SurfaceType",
		];

		for (const prop of commonProps) {
			const [propSuccess, propValue] = pcall(() => {
				const val = (instance as unknown as Record<string, unknown>)[prop];
				if (typeOf(val) === "UDim2") {
					const udim = val as UDim2;
					return {
						X: { Scale: udim.X.Scale, Offset: udim.X.Offset },
						Y: { Scale: udim.Y.Scale, Offset: udim.Y.Offset },
						_type: "UDim2",
					};
				}
				return tostring(val);
			});
			if (propSuccess) properties[prop] = propValue;
		}

		if (instance.IsA("LuaSourceContainer")) {
			if (!excludeSource) {
				properties.Source = readScriptSource(instance);
			} else {
				const src = readScriptSource(instance);
				properties.SourceLength = src.size();
				properties.LineCount = Utils.splitLines(src)[0].size();
			}
			if (instance.IsA("BaseScript")) {
				properties.Enabled = tostring(instance.Enabled);
			}
		}

		if (instance.IsA("Part")) {
			properties.Shape = tostring(instance.Shape);
		}

		if (instance.IsA("BasePart")) {
			properties.TopSurface = tostring(instance.TopSurface);
			properties.BottomSurface = tostring(instance.BottomSurface);
		}

		if (instance.IsA("MeshPart")) {
			properties.MeshId = tostring(instance.MeshId);
			properties.TextureID = tostring(instance.TextureID);
		}

		if (instance.IsA("SpecialMesh")) {
			properties.MeshId = tostring(instance.MeshId);
			properties.TextureId = tostring(instance.TextureId);
			properties.MeshType = tostring(instance.MeshType);
		}

		if (instance.IsA("Sound")) {
			properties.SoundId = tostring(instance.SoundId);
			properties.TimeLength = tostring(instance.TimeLength);
			properties.IsPlaying = tostring(instance.IsPlaying);
		}

		if (instance.IsA("Animation")) {
			properties.AnimationId = tostring(instance.AnimationId);
		}

		if (instance.IsA("Decal") || instance.IsA("Texture")) {
			properties.Texture = tostring((instance as Decal | Texture).Texture);
		}

		if (instance.IsA("Shirt")) {
			properties.ShirtTemplate = tostring(instance.ShirtTemplate);
		} else if (instance.IsA("Pants")) {
			properties.PantsTemplate = tostring(instance.PantsTemplate);
		} else if (instance.IsA("ShirtGraphic")) {
			properties.Graphic = tostring(instance.Graphic);
		}

		properties.ChildCount = tostring(instance.GetChildren().size());
	});

	if (success) {
		return { instancePath, className: instance.ClassName, properties };
	} else {
		return { error: `Failed to get properties: ${result}` };
	}
}

const STRUCTURE_PATH_KEYWORDS = new Set<string>([
	"and", "break", "continue", "do", "else", "elseif", "end", "export",
	"false", "for", "function", "if", "in", "local", "nil", "not", "or",
	"repeat", "return", "then", "true", "type", "until", "while",
]);

function isStructurePathSegmentSimple(segment: string): boolean {
	return segment.match("^[%a_][%w_]*$")[0] !== undefined && !STRUCTURE_PATH_KEYWORDS.has(segment);
}

function quoteStructurePathSegment(segment: string): string {
	let escaped = segment.gsub("\\", "\\\\")[0];
	escaped = escaped.gsub("\n", "\\n")[0];
	escaped = escaped.gsub("\r", "\\r")[0];
	escaped = escaped.gsub("\t", "\\t")[0];
	escaped = escaped.gsub('"', '\\"')[0];
	return `"${escaped}"`;
}

function joinStructureChildPath(parentPath: string, childName: string): string {
	if (isStructurePathSegmentSimple(childName)) {
		return `${parentPath}.${childName}`;
	}
	return `${parentPath}[${quoteStructurePathSegment(childName)}]`;
}

function getProjectStructure(requestData: Record<string, unknown>) {
	const startPath = (requestData.path as string) ?? "";
	const maxDepth = (requestData.maxDepth as number) ?? 3;
	const showScriptsOnly = (requestData.scriptsOnly as boolean) ?? false;

	if (startPath === "" || startPath === "game") {
		const services: Record<string, unknown>[] = [];
		const mainServices = [
			"Workspace", "ServerScriptService", "ServerStorage", "ReplicatedStorage",
			"StarterGui", "StarterPack", "StarterPlayer", "Players",
		];

		for (const serviceName of mainServices) {
			const [svcOk, service] = pcall(() => game.GetService(serviceName as keyof Services));
			if (svcOk && service) {
				const svcInstance = service as Instance;
				const svcChildren = svcInstance.GetChildren();
				const childCount = svcChildren.size();
				services.push({
					name: service.Name,
					className: service.ClassName,
					path: getInstancePath(svcInstance),
					childCount,
					hasChildren: childCount > 0,
				});
			}
		}

		return {
			type: "service_overview",
			services,
			timestamp: tick(),
			note: "Use path parameter to explore specific locations (e.g., 'game.ServerScriptService')",
		};
	}

	const startInstance = getInstanceByPath(startPath);
	if (!startInstance) return { error: `Path not found: ${startPath}` };

	// Cache canonical paths so each node's ancestry walk happens once.
	// Child paths are derived from the cached parent path instead of
	// walking to the DataModel root again.
	const pathCache = new Map<Instance, string>();
	const startInstancePath = getInstancePath(startInstance);
	pathCache.set(startInstance, startInstancePath);

	function cachedChildPath(parent: Instance, parentPath: string, child: Instance): string {
		const hit = pathCache.get(child);
		if (hit !== undefined) return hit;
		let childPath: string;
		if (parent === game) {
			childPath = getInstancePath(child);
		} else {
			childPath = joinStructureChildPath(parentPath, child.Name);
		}
		pathCache.set(child, childPath);
		return childPath;
	}

	function getStructure(instance: Instance, depth: number, instancePath: string): Record<string, unknown> {
		const allChildren = instance.GetChildren();
		if (depth > maxDepth) {
			return {
				name: instance.Name,
				className: instance.ClassName,
				path: instancePath,
				childCount: allChildren.size(),
				hasMore: true,
				note: "Max depth reached - use this path to explore further",
			};
		}

		const node: Record<string, unknown> = {
			name: instance.Name,
			className: instance.ClassName,
			path: instancePath,
		};

		if (instance.IsA("LuaSourceContainer")) {
			node.hasSource = true;
			node.scriptType = instance.ClassName;
			if (instance.IsA("BaseScript")) {
				node.enabled = instance.Enabled;
			}
		}

		if (instance.IsA("GuiObject")) {
			node.visible = instance.Visible;
			if (instance.IsA("Frame") || instance.IsA("ScreenGui")) {
				node.guiType = "container";
			} else if (instance.IsA("TextLabel") || instance.IsA("TextButton")) {
				node.guiType = "text";
				const textInst = instance as TextLabel | TextButton;
				if (textInst.Text !== "") node.text = textInst.Text;
			} else if (instance.IsA("ImageLabel") || instance.IsA("ImageButton")) {
				node.guiType = "image";
			}
		}

		let children: Instance[];
		if (showScriptsOnly) {
			children = [];
			for (const child of allChildren) {
				if (child.IsA("BaseScript") || child.IsA("Folder") || child.IsA("ModuleScript")) {
					children.push(child);
				}
			}
		} else {
			children = allChildren;
		}

		const nodeChildren: Record<string, unknown>[] = [];
		const childCount = children.size();
		if (childCount > 20 && depth < maxDepth) {
			const classGroups = new Map<string, Instance[]>();
			for (const child of children) {
				const cn = child.ClassName;
				if (!classGroups.has(cn)) classGroups.set(cn, []);
				classGroups.get(cn)!.push(child);
			}

			const childSummary: Record<string, unknown>[] = [];
			classGroups.forEach((classChildren, cn) => {
				childSummary.push({
					className: cn,
					count: classChildren.size(),
					examples: [classChildren[0]?.Name, classChildren[1]?.Name],
				});
			});
			node.childSummary = childSummary;

			classGroups.forEach((classChildren, cn) => {
				const limit = math.min(3, classChildren.size());
				for (let i = 0; i < limit; i++) {
					const child = classChildren[i];
					nodeChildren.push(getStructure(child, depth + 1, cachedChildPath(instance, instancePath, child)));
				}
				if (classChildren.size() > 3) {
					nodeChildren.push({
						name: `... ${classChildren.size() - 3} more ${cn} objects`,
						className: "MoreIndicator",
						path: `${instancePath} [${cn} children]`,
						note: "Use specific path to explore these objects",
					});
				}
			});
		} else {
			for (const child of children) {
				nodeChildren.push(getStructure(child, depth + 1, cachedChildPath(instance, instancePath, child)));
			}
		}
		if (nodeChildren.size() > 0) {
			node.children = nodeChildren;
		}

		return node;
	}

	const result = getStructure(startInstance, 0, startInstancePath);
	result.requestedPath = startPath;
	result.maxDepth = maxDepth;
	result.scriptsOnly = showScriptsOnly;
	result.timestamp = tick();

	return result;
}

interface ScriptSnapshot {
	instancePath: string;
	name: string;
	className: string;
	enabled?: boolean;
	source: string;
}

const scriptSearch = ScriptSearch.createScriptSearch({
	resolveRoot(path: string): Instance | undefined {
		return getInstanceByPath(path);
	},
	getChildren(instance: Instance): Instance[] {
		return instance.GetChildren();
	},
	readScript(instance: Instance, classFilter?: string): ScriptSnapshot | undefined {
		if (
			!instance.IsA("LuaSourceContainer") ||
			(classFilter !== undefined && instance.ClassName !== classFilter)
		) {
			return undefined;
		}
		const snapshot: ScriptSnapshot = {
			instancePath: getInstancePath(instance),
			name: instance.Name,
			className: instance.ClassName,
			source: readScriptSource(instance),
		};
		if (instance.IsA("BaseScript")) snapshot.enabled = instance.Enabled;
		return snapshot;
	},
});

function grepScripts(
	requestData: Record<string, unknown>,
	execution: StudioRequestContext,
): unknown {
	const result = CooperativeJobRunner.runExclusive(
		"script-source-search",
		execution,
		(control) => scriptSearch.search(requestData, control),
	);
	if (result.error === "plugin_busy") {
		return {
			...result,
			message: "Another grep_scripts request is already running in this Studio DataModel. Retry after it completes.",
		};
	}
	if (result.error === "deadline_exceeded") {
		return {
			...result,
			message: "grep_scripts exceeded its bridge deadline before the scan completed.",
		};
	}
	return result;
}

export = {
    getPlaceInfo,
    searchObjects,
    getInstanceProperties,
    getProjectStructure,
    grepScripts,
};
