type AnyBlockLike = { type: string; props?: { level?: number } };

export function findLevelHeadings<T extends AnyBlockLike>(blocks: T[], level: number): T[] {
  return blocks.filter((b) => b.type === "heading" && (b.props?.level ?? 1) === level);
}
