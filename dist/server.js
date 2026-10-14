import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PLUGIN_ROOT, getStatus, syncRepo, prepareWorktree, queueAudit, applyFix, pauseWatchdog, resumeWatchdog, checkSynthesis, dispatchSynthesis, cancelSynthesis, manageGoal, executePlan, readReportMarkdown } from "./bridge.js";
const PANEL_DIR = join(PLUGIN_ROOT, "sidecars", "panel");
function parseJsonBody(req) {
    return new Promise((resolve) => {
        let body = "";
        req.on("data", (chunk) => {
            body += chunk;
            if (body.length > 5 * 1024 * 1024) {
                req.destroy();
                resolve({});
            }
        });
        req.on("end", () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            }
            catch {
                resolve({});
            }
        });
        req.on("error", () => resolve({}));
    });
}
function sendJson(res, data, statusCode = 200) {
    const payload = JSON.stringify(data);
    res.writeHead(statusCode, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end(payload);
}
function sendFile(res, filePath, contentType) {
    if (!existsSync(filePath)) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not Found");
        return;
    }
    const content = readFileSync(filePath);
    res.writeHead(200, {
        "Content-Type": contentType,
        "Content-Length": content.length,
        "Cache-Control": "no-cache",
    });
    res.end(content);
}
export function startDashboardServer(preferredPort = 4198) {
    return new Promise((resolve, reject) => {
        const server = createServer(async (req, res) => {
            const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
            const pathname = url.pathname;
            if (req.method === "OPTIONS") {
                res.writeHead(204, {
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
                    "Access-Control-Allow-Headers": "Content-Type",
                });
                res.end();
                return;
            }
            try {
                if (pathname === "/" || pathname === "/index.html") {
                    sendFile(res, join(PANEL_DIR, "index.html"), "text/html; charset=utf-8");
                    return;
                }
                if (pathname === "/preload.js") {
                    res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
                    res.end("// Standalone preload stub\nwindow.sidecar = window.sidecar || {};");
                    return;
                }
                if (pathname === "/app.js") {
                    sendFile(res, join(PANEL_DIR, "app.js"), "application/javascript; charset=utf-8");
                    return;
                }
                if (pathname === "/styles.css") {
                    sendFile(res, join(PANEL_DIR, "styles.css"), "text/css; charset=utf-8");
                    return;
                }
                if (pathname === "/api/dashboard" || pathname === "/api/status") {
                    let repo = url.searchParams.get("repo");
                    if (!repo && req.method === "POST") {
                        const body = await parseJsonBody(req);
                        repo = body.repo || body.repo_path || (Array.isArray(body.workspaceUris) ? body.workspaceUris[0] : undefined);
                    }
                    const status = await syncRepo(repo || undefined);
                    sendJson(res, status);
                    return;
                }
                if (pathname === "/api/sync" && req.method === "POST") {
                    const body = await parseJsonBody(req);
                    const result = await syncRepo(body.repo_path || body.repo);
                    sendJson(res, result);
                    return;
                }
                if (pathname === "/api/settings" && req.method === "POST") {
                    const body = await parseJsonBody(req);
                    if (body.paused === true) {
                        await pauseWatchdog();
                    }
                    else if (body.paused === false) {
                        await resumeWatchdog();
                    }
                    sendJson(res, await getStatus());
                    return;
                }
                if (pathname === "/api/trigger" && req.method === "POST") {
                    const body = await parseJsonBody(req);
                    const repo = body.repo_path || body.repo;
                    const sha = body.sha;
                    if (!repo || !sha) {
                        sendJson(res, { error: "Missing repo or sha" }, 400);
                        return;
                    }
                    await prepareWorktree(repo, sha);
                    const queued = await queueAudit(repo, sha, body.comment);
                    sendJson(res, queued);
                    return;
                }
                if (pathname === "/api/apply-fix" && req.method === "POST") {
                    const body = await parseJsonBody(req);
                    const repo = body.repo_path || body.repo;
                    const sha = body.sha;
                    if (!repo || !sha) {
                        sendJson(res, { error: "Missing repo or sha" }, 400);
                        return;
                    }
                    const result = await applyFix(repo, sha);
                    sendJson(res, result);
                    return;
                }
                if (pathname === "/api/report" && req.method === "POST") {
                    const body = await parseJsonBody(req);
                    const reportPath = body.report_path;
                    if (!reportPath) {
                        sendJson(res, { error: "Missing report_path" }, 400);
                        return;
                    }
                    const content = readReportMarkdown(reportPath);
                    sendJson(res, { content });
                    return;
                }
                if (pathname === "/api/next-steps" && (req.method === "GET" || req.method === "POST")) {
                    let repo = url.searchParams.get("repo");
                    if (!repo && req.method === "POST") {
                        const body = await parseJsonBody(req);
                        repo = body.repo || body.repo_path;
                    }
                    if (!repo) {
                        sendJson(res, { error: "Missing repo parameter" }, 400);
                        return;
                    }
                    const result = await checkSynthesis(repo);
                    sendJson(res, result);
                    return;
                }
                if (pathname === "/api/next-steps/refresh" && req.method === "POST") {
                    const body = await parseJsonBody(req);
                    const repo = body.repo || body.repo_path;
                    if (!repo) {
                        sendJson(res, { error: "Missing repo parameter" }, 400);
                        return;
                    }
                    const result = await dispatchSynthesis(repo);
                    sendJson(res, result);
                    return;
                }
                if (pathname === "/api/next-steps/cancel" && req.method === "POST") {
                    const body = await parseJsonBody(req);
                    const repo = body.repo || body.repo_path;
                    if (!repo) {
                        sendJson(res, { error: "Missing repo parameter" }, 400);
                        return;
                    }
                    const result = await cancelSynthesis(repo);
                    sendJson(res, result);
                    return;
                }
                if (pathname === "/api/next-steps/goal" && req.method === "POST") {
                    const body = await parseJsonBody(req);
                    const repo = body.repo || body.repo_path;
                    if (!repo) {
                        sendJson(res, { error: "Missing repo parameter" }, 400);
                        return;
                    }
                    const result = await manageGoal(repo, body.goal, Boolean(body.clear));
                    sendJson(res, result);
                    return;
                }
                if (pathname === "/api/next-steps/plan" && req.method === "POST") {
                    const body = await parseJsonBody(req);
                    const repo = String(body.repo || body.repo_path || "").trim();
                    const planPath = String(body.planPath || "").trim();
                    const planFile = String(body.planFile || "").trim();
                    let target = "";
                    if (planPath && existsSync(planPath)) {
                        target = planPath;
                    }
                    else if (repo && planFile && existsSync(join(repo, planFile))) {
                        target = join(repo, planFile);
                    }
                    if (!target || !existsSync(target)) {
                        sendJson(res, { ok: false, error: "Plan file not found" });
                        return;
                    }
                    try {
                        sendJson(res, {
                            ok: true,
                            path: target,
                            content: readFileSync(target, "utf8"),
                        });
                    }
                    catch (err) {
                        sendJson(res, { ok: false, error: err.message });
                    }
                    return;
                }
                if (pathname === "/api/next-steps/execute" && req.method === "POST") {
                    const body = await parseJsonBody(req);
                    const repo = body.repo || body.repo_path;
                    const planId = body.planId;
                    if (!repo || !planId) {
                        sendJson(res, { error: "Missing repo or planId" }, 400);
                        return;
                    }
                    const result = await executePlan(repo, planId);
                    sendJson(res, result);
                    return;
                }
                sendJson(res, { error: "Not Found", path: pathname }, 404);
            }
            catch (err) {
                sendJson(res, { error: err.message || "Internal server error" }, 500);
            }
        });
        server.listen(preferredPort, "127.0.0.1", () => {
            const addr = server.address();
            const port = addr.port;
            const url = `http://127.0.0.1:${port}`;
            resolve({
                port,
                url,
                close: () => new Promise((res) => server.close(() => res())),
            });
        });
        server.on("error", (err) => {
            if (err.code === "EADDRINUSE" && preferredPort !== 0) {
                // Fall back to dynamic port
                startDashboardServer(0).then(resolve).catch(reject);
            }
            else {
                reject(err);
            }
        });
    });
}
//# sourceMappingURL=server.js.map