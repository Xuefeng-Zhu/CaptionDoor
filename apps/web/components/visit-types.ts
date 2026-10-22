import type { Visit } from "@captiondoor/domain";
import type { VisitCommand } from "@captiondoor/contracts";
export type CommandInput = VisitCommand extends infer C
  ? C extends VisitCommand
    ? Omit<C, "expectedVersion">
    : never
  : never;
export type PerformVisitCommand = (
  command: CommandInput,
) => Promise<{ visit: Visit } | null>;
