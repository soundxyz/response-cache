export function chunk<T>(array: T[], size: number) {
  const chunked: T[][] = [];
  if (size < 1) return [array];
  for (let i = 0; i < array.length; i += size) {
    chunked.push(array.slice(i, i + size));
  }
  return chunked;
}
