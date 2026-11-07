#!/usr/bin/env node
export declare const VALUE_FLAGS: Set<string>;
export declare function parseArgs(args: string[]): {
    cmd: string;
    flags: Record<string, string | boolean>;
    positionals: string[];
};
export declare function runCli(): Promise<void>;
//# sourceMappingURL=cli.d.ts.map