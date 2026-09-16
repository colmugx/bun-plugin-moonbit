export { moonbit, type MoonbitPlugin, type MoonbitPluginOptions } from "./plugin";
export { generateDts, type GenerateDtsOptions, type GenerateDtsResult } from "./dts";
export { sizeReport, decodeMangledPackage, type SizeEntry } from "./size";
export {
  buildOnce,
  moonInfo,
  ensureMbti,
  parseDiagnostics,
  MoonBuildError,
  MoonDiagnosticParseError,
  type MoonDiagnostic,
  type MoonSpawnOptions,
} from "./moon";
export {
  findProject,
  buildDir,
  matchMember,
  resolveModule,
  type ProjectInfo,
  type MemberInfo,
  type ModuleResolution,
} from "./manifest";
export { LinkManifest } from "./link";
