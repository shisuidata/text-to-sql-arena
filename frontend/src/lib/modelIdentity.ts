export function displayModelName(name: string): string {
  return name.replace(/\s*本机实测\s*/g, " ").replace(/Pi 订阅/g, "订阅").replace(/\s{2,}/g, " ").trim();
}
