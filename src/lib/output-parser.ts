export function parseJsonBlock(text: string): any {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] ?? text.slice(text.lastIndexOf("{"));
  return JSON.parse(candidate.trim());
}
