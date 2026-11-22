import { isAbsolute, relative, sep } from "node:path";
export interface TreeNode {
  path: string;
  files: string[];
  children: Map<string, TreeNode>;
}

export function inside(root: string, path: string): boolean {
  const relativePath = relative(root, path);
  const escapesParent = relativePath === ".." || relativePath.startsWith(`..${sep}`);

  return !isAbsolute(relativePath) && !escapesParent;
}

export function relativePath(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

function createNode(path: string): TreeNode {
  return { path, files: [], children: new Map() };
}

function insertFile(root: TreeNode, path: string): void {
  const parts = path.split("/");
  const invalidSegment = parts.some((part) => part === "" || part === "." || part === "..");

  if (isAbsolute(path) || invalidSegment) {
    throw new Error("Invalid scan path");
  }

  let node = root;

  for (let index = 0; index < parts.length; index++) {
    const key = parts.slice(0, index + 1).join("/");
    const child = node.children.get(key) ?? createNode(key);

    node.children.set(key, child);
    node.files.push(path);
    node = child;
  }

  node.files.push(path);
}

export function treeFrom(files: string[]): TreeNode {
  const root = createNode(".");

  for (const path of files) {
    insertFile(root, path);
  }

  return root;
}
