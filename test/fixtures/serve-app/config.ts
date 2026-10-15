export interface Config {
  name: string;
}

export async function loadConfig(url: URL): Promise<Config> {
  const text = await Deno.readTextFile(url);
  return JSON.parse(text) as Config;
}
