export interface DashboardServer {
    port: number;
    url: string;
    close: () => Promise<void>;
}
export declare function startDashboardServer(preferredPort?: number): Promise<DashboardServer>;
//# sourceMappingURL=server.d.ts.map