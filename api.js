/* exported GitLabClient, loadConfig, saveConfig, CONFIG_PATH, CACHE_DIR */
'use strict';

imports.gi.versions.Soup = '2.4';
const { Gio, GLib, Soup } = imports.gi;

var CONFIG_PATH = GLib.build_filenamev([GLib.get_user_config_dir(), 'gitlab-mrs', 'config.json']);
var CACHE_DIR = GLib.build_filenamev([GLib.get_user_cache_dir(), 'gitlab-mrs']);

const DEFAULTS = { url: 'https://gitlab.com', token: '', refresh_seconds: 120, notifications: true };

function loadConfig() {
    let raw;
    try {
        const [, bytes] = GLib.file_get_contents(CONFIG_PATH);
        raw = JSON.parse(imports.byteArray.toString(bytes));
    } catch (e) {
        return { ...DEFAULTS, error: `Configuração não encontrada em ${CONFIG_PATH}` };
    }
    const cfg = { ...DEFAULTS, ...raw };
    cfg.url = String(cfg.url).replace(/\/+$/, '').replace(/\/api\/v4$/, '');
    cfg.refresh_seconds = Math.max(30, Number(cfg.refresh_seconds) || DEFAULTS.refresh_seconds);
    if (!cfg.token)
        cfg.error = `Defina "token" em ${CONFIG_PATH}`;
    return cfg;
}

// Writes the editable keys, keeping any other key already in the file.
// The file holds the token, so it stays readable by the user only.
function saveConfig(values) {
    let raw = {};
    try {
        const [, bytes] = GLib.file_get_contents(CONFIG_PATH);
        raw = JSON.parse(imports.byteArray.toString(bytes));
    } catch (e) {
        raw = {};
    }
    const cfg = { ...raw, ...values };
    GLib.mkdir_with_parents(GLib.path_get_dirname(CONFIG_PATH), 0o700);
    GLib.file_set_contents(CONFIG_PATH, `${JSON.stringify(cfg, null, 2)}\n`);
    Gio.File.new_for_path(CONFIG_PATH).set_attribute_uint32('unix::mode', 0o600,
        Gio.FileQueryInfoFlags.NONE, null);
}

function httpError(msg) {
    const code = msg.status_code;
    if (code === 401)
        return 'Token inválido ou expirado (401)';
    if (code === 403)
        return 'Sem permissão para acessar a API (403)';
    if (code < 100)
        return 'Sem conexão com o GitLab';
    return `GitLab respondeu HTTP ${code}`;
}

function shortProject(fullPath) {
    const parts = fullPath.split('/');
    return parts.length > 2 ? parts.slice(-2).join(' / ') : parts.join(' / ');
}

var GitLabClient = class {
    constructor(cfg) {
        this._base = cfg.url;
        this._token = cfg.token;
        this._session = new Soup.Session({ timeout: 20, user_agent: 'gitlab-mrs-indicator/1' });
        this.user = null;
    }

    get baseUrl() {
        return this._base;
    }

    destroy() {
        this._session.abort();
        this._session = null;
    }

    _send(path) {
        return new Promise((resolve, reject) => {
            const url = path.startsWith('http') ? path : `${this._base}/api/v4${path}`;
            const msg = Soup.Message.new('GET', url);
            if (!msg) {
                reject(new Error(`URL inválida: ${url}`));
                return;
            }
            if (url.startsWith(this._base))
                msg.request_headers.append('PRIVATE-TOKEN', this._token);
            this._session.queue_message(msg, (_s, m) => {
                if (m.status_code >= 200 && m.status_code < 300)
                    resolve(m);
                else
                    reject(new Error(httpError(m)));
            });
        });
    }

    async _json(path) {
        const msg = await this._send(path);
        return JSON.parse(msg.response_body.data);
    }

    async _downloadAvatar(url) {
        if (!url)
            return null;
        const target = GLib.build_filenamev([CACHE_DIR, 'avatar.png']);
        try {
            const msg = await this._send(url);
            GLib.mkdir_with_parents(CACHE_DIR, 0o700);
            const bytes = msg.response_body.flatten().get_as_bytes();
            Gio.File.new_for_path(target).replace_contents(bytes.get_data(), null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION, null);
            return target;
        } catch (e) {
            return null;
        }
    }

    async _enrich(mr) {
        const base = `/projects/${mr.project_id}/merge_requests/${mr.iid}`;
        const [detail, approvals] = await Promise.all([
            this._json(base).catch(() => null),
            this._json(`${base}/approvals`).catch(() => null),
        ]);
        const fullRef = (mr.references && mr.references.full) || `${mr.project_id}!${mr.iid}`;
        const project = fullRef.split('!')[0];
        const pipeline = detail && detail.head_pipeline;
        return {
            id: mr.id,
            projectId: mr.project_id,
            iid: mr.iid,
            ref: `!${mr.iid}`,
            title: mr.title.replace(/^(Draft|WIP):\s*/i, ''),
            draft: Boolean(mr.draft || mr.work_in_progress),
            project,
            projectShort: shortProject(project),
            url: mr.web_url,
            source: mr.source_branch,
            target: mr.target_branch,
            createdAt: mr.created_at,
            updatedAt: mr.updated_at,
            author: mr.author ? mr.author.name : '',
            authorUsername: mr.author ? mr.author.username : '',
            notes: mr.user_notes_count || 0,
            conflicts: Boolean(mr.has_conflicts),
            threadsOpen: mr.blocking_discussions_resolved === false,
            pipeline: pipeline ? pipeline.status : null,
            pipelineUrl: pipeline ? pipeline.web_url : null,
            pipelineId: pipeline ? pipeline.id : null,
            mergeStatus: detail ? detail.detailed_merge_status || detail.merge_status : mr.merge_status,
            approvedBy: approvals && approvals.approved_by
                ? approvals.approved_by.map(a => a.user.name) : [],
            approvalsLeft: approvals ? approvals.approvals_left || 0 : 0,
            approvalsRequired: approvals ? approvals.approvals_required || 0 : 0,
        };
    }

    // Newest notes first (comments and system notes) of one MR.
    recentNotes(projectId, iid, perPage = 10) {
        return this._json(
            `/projects/${projectId}/merge_requests/${iid}/notes?sort=desc&order_by=created_at&per_page=${perPage}`);
    }

    mergeRequest(projectId, iid) {
        return this._json(`/projects/${projectId}/merge_requests/${iid}`);
    }

    // Names of the jobs that broke a pipeline (allowed failures don't count).
    async failedJobs(projectId, pipelineId) {
        const jobs = await this._json(
            `/projects/${projectId}/pipelines/${pipelineId}/jobs?scope%5B%5D=failed&per_page=50`);
        return [...new Set(jobs.filter(j => !j.allow_failure).map(j => j.name))];
    }

    async fetchAll() {
        if (!this.user) {
            this.user = await this._json('/user');
            this.user.avatarPath = await this._downloadAvatar(this.user.avatar_url);
        }
        const q = 'state=opened&per_page=100&order_by=updated_at';
        const [mine, review] = await Promise.all([
            this._json(`/merge_requests?scope=created_by_me&${q}`),
            this._json(`/merge_requests?scope=all&reviewer_username=${encodeURIComponent(this.user.username)}&${q}`),
        ]);
        const mineIds = new Set(mine.map(m => m.id));
        const reviewOnly = review.filter(m => !mineIds.has(m.id));
        const [mineFull, reviewFull] = await Promise.all([
            Promise.all(mine.map(m => this._enrich(m))),
            Promise.all(reviewOnly.map(m => this._enrich(m))),
        ]);
        return { user: this.user, mine: mineFull, review: reviewFull, fetchedAt: GLib.DateTime.new_now_local() };
    }
};
