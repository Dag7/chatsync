import { confirm, input, select } from "@inquirer/prompts";

/** The only prompt surface the CLI knows; tests inject a fake. */
export interface Prompter {
  select<T extends string>(message: string, choices: { name: string; value: T }[]): Promise<T>;
  confirm(message: string): Promise<boolean>;
  input(message: string, defaultValue?: string): Promise<string>;
}

/** Real terminal prompts via @inquirer/prompts. Ctrl+C rejects with `ExitPromptError`, handled in `runCli`. */
export function inquirerPrompter(): Prompter {
  return {
    select: <T extends string>(message: string, choices: { name: string; value: T }[]): Promise<T> =>
      select<T>({ message, choices }),
    confirm: (message: string): Promise<boolean> => confirm({ message, default: false }),
    input: (message: string, defaultValue?: string): Promise<string> =>
      input({ message, ...(defaultValue !== undefined ? { default: defaultValue } : {}) }),
  };
}
