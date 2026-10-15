export interface GreetOptions {
  punctuation?: string;
}

export function greet(name: string, options: GreetOptions = {}): string {
  return `Hello, ${name}${options.punctuation ?? "!"}`;
}
