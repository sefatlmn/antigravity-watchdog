export declare const PLUGIN_ROOT: string;
export declare const QA_CTL_SCRIPT: string;
export declare const QA_STOP_HOOK_SCRIPT: string;
export declare function getPythonBin(): string;
export declare function runCtlJson<T = any>(args: string[]): Promise<T>;
export declare function getStatus(repo?: string): Promise<any>;
export declare function syncRepo(repo?: string): Promise<any>;
export declare function prepareWorktree(repo: string, sha: string): Promise<any>;
export declare function queueAudit(repo: string, sha: string, userComment?: string): Promise<any>;
export declare function applyFix(repo: string, sha: string): Promise<any>;
export declare function continueAudit(repo?: string, sha?: string, jobId?: string): Promise<any>;
export declare function sendAuditComment(repo: string, comment: string, jobId?: string): Promise<any>;
export declare function pauseWatchdog(): Promise<any>;
export declare function resumeWatchdog(): Promise<any>;
export declare function synthesizeNextSteps(repo: string, force?: boolean): Promise<any>;
export declare function checkSynthesis(repo: string): Promise<any>;
export declare function dispatchSynthesis(repo: string): Promise<any>;
export declare function cancelSynthesis(repo: string): Promise<any>;
export declare function manageGoal(repo: string, goal?: string, clear?: boolean): Promise<any>;
export declare function executePlan(repo: string, planId: string): Promise<any>;
export declare function triggerStopHook(payload: {
    fullyIdle: boolean;
    terminationReason: string;
    workspacePaths: string[];
    conversationId?: string;
}): Promise<void>;
export declare function readReportMarkdown(reportPath: string): string;
//# sourceMappingURL=bridge.d.ts.map