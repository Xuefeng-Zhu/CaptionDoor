export * from "./repository";
export type { CaptionInput } from "./service";
import { coreService } from "./service";
import { jobService } from "./jobs";
export const service = { ...coreService, ...jobService };
