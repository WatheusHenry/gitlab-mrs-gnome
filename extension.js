/* exported init */
'use strict';

const { Clutter, Gio, GLib, GObject, Meta, Pango, St } = imports.gi;
const Main = imports.ui.main;
const MessageTray = imports.ui.messageTray;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;
const ExtensionUtils = imports.misc.extensionUtils;

const Me = ExtensionUtils.getCurrentExtension();
const { GitLabClient, loadConfig, saveConfig, CONFIG_PATH } = Me.imports.api;

// Project order chosen by dragging group headers; projects never placed go on top.
const ORDER_PATH = GLib.build_filenamev([GLib.path_get_dirname(CONFIG_PATH), 'project-order.json']);
const DRAG_THRESHOLD = 6;
const AUTOSCROLL_EDGE = 48;

function loadProjectOrder() {
    try {
        const [, bytes] = GLib.file_get_contents(ORDER_PATH);
        const order = JSON.parse(imports.byteArray.toString(bytes));
        return Array.isArray(order) ? order.filter(p => typeof p === 'string') : [];
    } catch (e) {
        return [];
    }
}

function saveProjectOrder(order) {
    try {
        GLib.mkdir_with_parents(GLib.path_get_dirname(ORDER_PATH), 0o700);
        GLib.file_set_contents(ORDER_PATH, JSON.stringify(order, null, 2));
    } catch (e) {
        logError(e, 'gitlab-mrs: falha ao salvar a ordem dos projetos');
    }
}

const PIPELINE = {
    success: { cls: 'ok', label: 'Pipeline passou' },
    failed: { cls: 'fail', label: 'Pipeline falhou' },
    running: { cls: 'run', label: 'Pipeline rodando' },
    pending: { cls: 'wait', label: 'Pipeline aguardando para rodar' },
    created: { cls: 'wait', label: 'Pipeline criado' },
    waiting_for_resource: { cls: 'wait', label: 'Aguardando recurso' },
    preparing: { cls: 'wait', label: 'Preparando pipeline' },
    scheduled: { cls: 'wait', label: 'Pipeline agendado' },
    manual: { cls: 'wait', label: 'Aguardando ação manual' },
    canceled: { cls: 'idle', label: 'Pipeline cancelado' },
    skipped: { cls: 'idle', label: 'Pipeline ignorado' },
};
const NO_PIPELINE = { cls: 'idle', label: 'Sem pipeline' };

const FILTERS = [
    { key: 'all', label: 'Todos', test: () => true },
    { key: 'ready', label: 'Prontos', test: m => isReady(m) },
    { key: 'failed', label: 'Pipeline falhou', test: m => m.pipeline === 'failed' },
    { key: 'conflict', label: 'Conflito', test: m => m.conflicts },
    { key: 'threads', label: 'Threads abertas', test: m => m.threadsOpen },
    { key: 'draft', label: 'Draft', test: m => m.draft },
    { key: 'review', label: 'Para revisar', test: m => m.forReview },
];

function isReady(m) {
    return !m.draft && !m.conflicts && !m.threadsOpen && m.approvalsLeft === 0 &&
        (m.pipeline === null || m.pipeline === 'success') &&
        ['can_be_merged', 'mergeable'].includes(m.mergeStatus);
}

// One status per row, shown in the colored circle (icons/ui/status-<cls>.svg).
// Most actionable first: draft, failed, conflict, open threads, running, waiting, then checks.
function rowStatus(m) {
    if (m.draft)
        return { cls: 'draft', label: 'Draft' };
    if (m.pipeline === 'failed')
        return PIPELINE.failed;
    if (m.conflicts)
        return { cls: 'conflict', label: 'Conflito' };
    if (m.threadsOpen)
        return { cls: 'threads', label: 'Threads abertas' };
    const p = PIPELINE[m.pipeline] || (m.pipeline ? { ...NO_PIPELINE, label: m.pipeline } : NO_PIPELINE);
    if (p.cls === 'run' || p.cls === 'wait')
        return p;
    if (isReady(m))
        return { cls: 'ok', label: 'Pronto para merge' };
    if (m.approvalsLeft > 0)
        return { cls: 'idle', label: `Aguardando ${m.approvalsLeft} aprovação${m.approvalsLeft > 1 ? 'ões' : ''}` };
    return { ...p, cls: 'idle' };
}

// Tooltip lines for the status circle: everything that can block the merge.
// failedJobs: undefined while loading, null when it could not be fetched.
function statusDetails(m, failedJobs) {
    const lines = [];
    const p = PIPELINE[m.pipeline];
    if (m.pipeline === 'failed') {
        if (failedJobs === undefined)
            lines.push('Pipeline falhou · buscando jobs…');
        else if (failedJobs && failedJobs.length)
            lines.push(`Pipeline falhou em: ${failedJobs.join(', ')}`);
        else
            lines.push('Pipeline falhou');
    } else {
        lines.push(p ? p.label : (m.pipeline || 'Sem pipeline'));
    }
    const approved = m.approvedBy.length;
    const required = Math.max(m.approvalsRequired, approved + m.approvalsLeft);
    if (required > 0 || approved > 0) {
        let text = `${approved} de ${Math.max(required, approved)} aprovaç${required === 1 ? 'ão' : 'ões'}`;
        if (approved)
            text += ` · ${m.approvedBy.join(', ')}`;
        lines.push(text);
    }
    if (m.conflicts)
        lines.push(`Conflito com ${m.target}: precisa de rebase ou merge`);
    if (m.threadsOpen)
        lines.push('Threads não resolvidas bloqueando o merge');
    if (m.draft)
        lines.push('Em draft: marque como pronto para liberar o merge');
    return lines;
}

// Floating label above the popup (St has no tooltip widget).
class Tooltip {
    constructor() {
        this._label = new St.Label({ style_class: 'gmr-tooltip', visible: false });
        this._label.clutter_text.line_wrap = true;
        // St.Label ellipsizes by default, which wins over wrapping
        this._label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        Main.layoutManager.uiGroup.add_child(this._label);
        this._source = null;
        this._build = null;
        this._timeoutId = 0;
    }

    schedule(source, build) {
        this.hide();
        this._source = source;
        this._build = build;
        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 350, () => {
            this._timeoutId = 0;
            this._show();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Re-render if `source` is the one showing (e.g. failed jobs just arrived).
    refresh(source) {
        if (this._source === source && this._label.visible)
            this._show();
    }

    _show() {
        const src = this._source;
        if (!src || !src.get_stage())
            return;
        this._label.clutter_text.set_markup(this._build());
        const [x, y] = src.get_transformed_position();
        const [, width] = this._label.get_preferred_width(-1);
        const [, height] = this._label.get_preferred_height(width);
        const mon = Main.layoutManager.monitors[Main.layoutManager.findIndexForActor(src)] ||
            Main.layoutManager.primaryMonitor;
        const tx = Math.min(x - 4, mon.x + mon.width - width - 8);
        let ty = y + src.height + 6;
        if (ty + height > mon.y + mon.height - 8)
            ty = y - height - 6;
        this._label.set_position(Math.round(Math.max(mon.x + 8, tx)), Math.round(ty));
        Main.layoutManager.uiGroup.set_child_above_sibling(this._label, null);
        this._label.show();
    }

    hide(source = null) {
        if (source && source !== this._source)
            return;
        if (this._timeoutId)
            GLib.source_remove(this._timeoutId);
        this._timeoutId = 0;
        this._source = null;
        this._label.hide();
    }

    destroy() {
        this.hide();
        this._label.destroy();
    }
}

function relTime(iso) {
    const then = GLib.DateTime.new_from_iso8601(iso, null);
    if (!then)
        return '';
    const secs = Math.max(0, GLib.DateTime.new_now_local().difference(then) / 1e6);
    if (secs < 60)
        return 'agora';
    const mins = Math.floor(secs / 60);
    if (mins < 60)
        return `há ${mins} min`;
    const hours = Math.floor(mins / 60);
    if (hours < 24)
        return `há ${hours} h`;
    const days = Math.floor(hours / 24);
    if (days < 30)
        return days === 1 ? 'ontem' : `há ${days} dias`;
    const months = Math.floor(days / 30);
    return months === 1 ? 'há 1 mês' : `há ${months} meses`;
}

// "commerce-apps/crm-cobranca/tasks#796 - Base de ..." -> ["tasks#796", "Base de ..."]
function splitIssuePrefix(title) {
    const m = title.match(/^\s*(?:[\w.-]+\/)*([\w.-]+#\d+)\s*[-–—:]\s*(.+)$/);
    return m ? [m[1], m[2]] : [null, title];
}

// Title as shown in the list: "tasks#843 - Título" instead of the full issue path.
function shortTitle(m) {
    const [issue, title] = splitIssuePrefix(m.title);
    return issue ? `${issue} - ${title}` : title;
}

function openUri(uri) {
    try {
        Gio.AppInfo.launch_default_for_uri(uri, global.create_app_launch_context(0, -1));
    } catch (e) {
        logError(e, 'gitlab-mrs: falha ao abrir link');
    }
}

// UI icons (icons/ui), colors baked in.
// Not "-symbolic" on purpose: symbolic recoloring would fill the stroke icons.
function asset(name) {
    return Gio.icon_new_for_string(`${Me.path}/icons/ui/${name}.svg`);
}

function label(text, styleClass, props = {}) {
    const l = new St.Label({ text, style_class: styleClass, y_align: Clutter.ActorAlign.CENTER, ...props });
    l.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    return l;
}

function iconButton(icon, accessibleName, onClick) {
    const b = new St.Button({
        style_class: 'gmr-icon-button',
        can_focus: true,
        y_align: Clutter.ActorAlign.CENTER,
        accessible_name: accessibleName,
        child: new St.Icon({ gicon: asset(icon), style_class: 'gmr-icon-button-icon' }),
    });
    b.connect('clicked', onClick);
    return b;
}

const MrIndicator = GObject.registerClass(
class MrIndicator extends PanelMenu.Button {
    _init() {
        super._init(0.5, 'GitLab MRs', false);

        this._filter = 'all';
        this._query = '';
        this._collapsed = new Set();
        this._projectOrder = loadProjectOrder();
        this._blocks = [];
        this._drag = null;
        this._tooltip = new Tooltip();
        this._seenReview = null;
        this._failedJobs = new Map();
        this._data = null;
        this._error = null;
        this._loading = false;
        this._lastFetch = 0;
        this._previous = null;
        this._timerId = 0;

        const panelBox = new St.BoxLayout({ style_class: 'panel-status-menu-box gmr-panel' });
        this._panelIcon = new St.Icon({
            gicon: Gio.icon_new_for_string(`${Me.path}/icons/merge-symbolic.svg`),
            style_class: 'system-status-icon',
        });
        this._panelCount = new St.Label({ text: '', y_align: Clutter.ActorAlign.CENTER, style_class: 'gmr-panel-count' });
        // Dot over the icon: something new to review since the popup was last opened
        this._panelDot = new St.Widget({
            style_class: 'gmr-panel-dot',
            visible: false,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.START,
        });
        const iconStack = new St.Widget({ layout_manager: new Clutter.BinLayout(), y_align: Clutter.ActorAlign.CENTER });
        iconStack.add_child(this._panelIcon);
        iconStack.add_child(this._panelDot);
        this._panelBox = panelBox;
        panelBox.add_child(iconStack);
        panelBox.add_child(this._panelCount);
        this.add_child(panelBox);

        this.menu.actor.add_style_class_name('gmr-popup');
        this._buildPopup();

        this.menu.connect('open-state-changed', (_m, open) => {
            if (!open) {
                this._tooltip.hide();
                this._endDrag(false);
                this._showSettings(false);
                return;
            }
            if (this._data && this._seenReview) {
                for (const m of this._data.review)
                    this._seenReview.add(m.id);
            }
            this._render();
            if (Date.now() - this._lastFetch > 30 * 1000)
                this._refresh();
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                this._search.grab_key_focus();
                return GLib.SOURCE_REMOVE;
            });
        });

        this._reloadConfig();
        this._refresh();
    }

    _reloadConfig() {
        if (this._client)
            this._client.destroy();
        this._client = null;
        this._config = loadConfig();
        if (!this._config.error)
            this._client = new GitLabClient(this._config);

        if (this._timerId)
            GLib.source_remove(this._timerId);
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, this._config.refresh_seconds, () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    // ---------- layout ----------

    _buildPopup() {
        this._root = new St.BoxLayout({ vertical: true, style_class: 'gmr-root' });

        // Header: avatar · search · refresh · settings
        const header = new St.BoxLayout({ style_class: 'gmr-header' });
        const identity = new St.BoxLayout({ style_class: 'gmr-header-side', y_align: Clutter.ActorAlign.CENTER });
        // Avatar: on hover it darkens and shows a browser icon; click opens the MRs on GitLab
        this._avatar = new St.Bin({ style_class: 'gmr-avatar' });
        const avatarOverlay = new St.Bin({
            style_class: 'gmr-avatar-overlay',
            visible: false,
            child: new St.Icon({ gicon: asset('browser'), style_class: 'gmr-avatar-overlay-icon' }),
        });
        const avatarStack = new St.Widget({ layout_manager: new Clutter.BinLayout() });
        avatarStack.add_child(this._avatar);
        avatarStack.add_child(avatarOverlay);
        this._avatarButton = new St.Button({
            style_class: 'gmr-avatar-button',
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
            accessible_name: 'Abrir meus merge requests no GitLab',
            child: avatarStack,
        });
        const syncOverlay = b => (avatarOverlay.visible = b.hover || b.has_key_focus());
        this._avatarButton.connect('notify::hover', syncOverlay);
        this._avatarButton.connect('key-focus-in', syncOverlay);
        this._avatarButton.connect('key-focus-out', syncOverlay);
        this._avatarButton.connect('clicked', () => {
            const username = this._data ? this._data.user.username : '';
            this.menu.close();
            openUri(username
                ? `${this._config.url}/dashboard/merge_requests?author_username=${encodeURIComponent(username)}`
                : `${this._config.url}/dashboard/merge_requests`);
        });
        identity.add_child(this._avatarButton);
        this._backButton = iconButton('back', 'Voltar para os merge requests', () => this._showSettings(false));
        this._backButton.visible = false;
        identity.add_child(this._backButton);
        header.add_child(identity);

        this._search = new St.Entry({
            style_class: 'gmr-search',
            hint_text: 'Filtrar por título, projeto, branch…',
            can_focus: true,
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            primary_icon: new St.Icon({ gicon: asset('search'), style_class: 'gmr-search-icon' }),
        });
        this._search.clutter_text.connect('text-changed', () => {
            this._query = this._search.get_text().trim().toLowerCase();
            this._renderList();
        });
        header.add_child(this._search);
        this._viewTitle = new St.Label({
            text: 'Configurações',
            style_class: 'gmr-view-title',
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        header.add_child(this._viewTitle);

        const actions = new St.BoxLayout({ style_class: 'gmr-header-side gmr-header-actions', y_align: Clutter.ActorAlign.CENTER });
        const actionsInner = new St.BoxLayout({ style_class: 'gmr-header-actions', x_expand: true, x_align: Clutter.ActorAlign.END });
        this._headerActions = actionsInner;
        actions.add_child(actionsInner);
        this._refreshButton = iconButton('refresh', 'Atualizar', () => this._refresh(true));
        actionsInner.add_child(this._refreshButton);
        actionsInner.add_child(iconButton('settings', 'Configurações', () => this._showSettings(true)));
        header.add_child(actions);
        this._root.add_child(header);

        // MR list view (chips + list or empty state); swapped with the settings view
        this._mainView = new St.BoxLayout({ vertical: true, style_class: 'gmr-main-view', x_expand: true });
        this._root.add_child(this._mainView);

        // Filter chips
        this._chips = new St.BoxLayout({ style_class: 'gmr-chips', x_align: Clutter.ActorAlign.CENTER });
        this._mainView.add_child(this._chips);

        // List
        this._list = new St.BoxLayout({ vertical: true, style_class: 'gmr-list', x_expand: true });
        this._scroll = new St.ScrollView({
            style_class: 'gmr-scroll',
            x_expand: true,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
        });
        this._scroll.add_actor(this._list);
        this._listArea = new St.Widget({ layout_manager: new Clutter.BinLayout(), x_expand: true });
        this._listArea.add_child(this._scroll);
        this._listArea.add_child(new St.Widget({
            style_class: 'gmr-fade',
            reactive: false,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.END,
        }));
        this._mainView.add_child(this._listArea);

        // Empty / loading / error state, same footprint as the list
        this._emptyBox = new St.Bin({
            style_class: 'gmr-empty-box',
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.FILL,
            visible: false,
        });
        this._mainView.add_child(this._emptyBox);

        this._settingsView = this._buildSettings();
        this._root.add_child(this._settingsView);

        const section = new PopupMenu.PopupMenuSection();
        section.actor.add_child(this._root);
        this.menu.addMenuItem(section);
    }

    // ---------- settings ----------

    _buildSettings() {
        const view = new St.BoxLayout({ vertical: true, style_class: 'gmr-settings', x_expand: true, visible: false });

        const field = (title, widget, hint) => {
            const box = new St.BoxLayout({ vertical: true, style_class: 'gmr-field' });
            box.add_child(new St.Label({ text: title, style_class: 'gmr-field-label' }));
            box.add_child(widget);
            if (hint) {
                const h = new St.Label({ text: hint, style_class: 'gmr-field-hint' });
                h.clutter_text.line_wrap = true;
                h.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
                box.add_child(h);
            }
            return box;
        };
        const card = (title, ...children) => {
            const box = new St.BoxLayout({ vertical: true, style_class: 'gmr-card' });
            box.add_child(new St.Label({ text: title, style_class: 'gmr-card-title' }));
            for (const c of children)
                box.add_child(c);
            return box;
        };
        const row = (title, hint, widget) => {
            const box = new St.BoxLayout({ style_class: 'gmr-setting-row' });
            const texts = new St.BoxLayout({ vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER });
            texts.add_child(new St.Label({ text: title, style_class: 'gmr-field-label' }));
            if (hint)
                texts.add_child(new St.Label({ text: hint, style_class: 'gmr-field-hint' }));
            box.add_child(texts);
            widget.y_align = Clutter.ActorAlign.CENTER;
            box.add_child(widget);
            return box;
        };
        const entry = (EntryClass, hint, props = {}) => {
            const e = new EntryClass({ style_class: 'gmr-input', hint_text: hint, can_focus: true, x_expand: true, ...props });
            e.clutter_text.connect('activate', () => this._saveSettings());
            return e;
        };

        this._urlEntry = entry(St.Entry, 'https://gitlab.com');
        this._tokenEntry = entry(St.PasswordEntry, 'glpat-…', { show_peek_icon: true });
        this._intervalEntry = entry(St.Entry, '120');

        // Toggle drawn in CSS (the theme's switch is an orange image)
        this._notifySwitch = new St.Button({
            style_class: 'gmr-switch',
            toggle_mode: true,
            can_focus: true,
            accessible_name: 'Notificações',
            child: new St.Widget({ style_class: 'gmr-switch-knob', y_align: Clutter.ActorAlign.CENTER }),
        });
        this._notifySwitch.connect('notify::checked', b => {
            b.child.x_align = b.checked ? Clutter.ActorAlign.END : Clutter.ActorAlign.START;
        });

        const resetOrder = new St.Button({ style_class: 'gmr-secondary', can_focus: true, label: 'Restaurar' });
        resetOrder.connect('clicked', () => {
            this._projectOrder = [];
            saveProjectOrder([]);
            this._renderList();
            this._setSettingsStatus('Ordem dos projetos restaurada', false);
        });

        view.add_child(card('Conta do GitLab',
            field('URL do GitLab', this._urlEntry),
            field('Token de acesso', this._tokenEntry, 'Personal access token com o escopo read_api.')));
        view.add_child(card('Atualização',
            field('Atualizar a cada (segundos)', this._intervalEntry, 'Mínimo de 30 segundos.'),
            row('Notificações', 'Pipeline, aprovações e novos MRs para revisar', this._notifySwitch)));
        view.add_child(card('Lista',
            row('Ordem dos projetos', 'Volta a ordenar pelo MR atualizado mais recentemente', resetOrder)));

        const footer = new St.BoxLayout({ style_class: 'gmr-settings-footer', y_expand: true, y_align: Clutter.ActorAlign.END });
        this._settingsStatus = new St.Label({ text: '', style_class: 'gmr-settings-status', x_expand: true, y_align: Clutter.ActorAlign.CENTER });
        this._settingsStatus.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        footer.add_child(this._settingsStatus);
        const save = new St.Button({ style_class: 'gmr-action gmr-save', can_focus: true, label: 'Salvar' });
        save.connect('clicked', () => this._saveSettings());
        footer.add_child(save);
        view.add_child(footer);
        return view;
    }

    _showSettings(show) {
        if (Boolean(this._inSettings) === show)
            return;
        this._inSettings = show;
        this._settingsView.visible = show;
        this._mainView.visible = !show;
        this._search.visible = !show;
        this._viewTitle.visible = show;
        this._avatarButton.visible = !show;
        this._backButton.visible = show;
        this._headerActions.opacity = show ? 0 : 255;
        this._headerActions.reactive = !show;
        for (const b of this._headerActions.get_children())
            b.can_focus = !show;
        if (!show) {
            this._search.grab_key_focus();
            return;
        }
        const cfg = loadConfig();
        this._urlEntry.set_text(cfg.url || '');
        this._tokenEntry.set_text(cfg.token || '');
        this._intervalEntry.set_text(String(cfg.refresh_seconds));
        this._notifySwitch.checked = Boolean(cfg.notifications);
        this._notifySwitch.child.x_align = cfg.notifications ? Clutter.ActorAlign.END : Clutter.ActorAlign.START;
        this._setSettingsStatus('', false);
        this._urlEntry.grab_key_focus();
    }

    _setSettingsStatus(text, isError) {
        this._settingsStatus.text = text;
        if (isError)
            this._settingsStatus.add_style_class_name('gmr-settings-error');
        else
            this._settingsStatus.remove_style_class_name('gmr-settings-error');
    }

    _saveSettings() {
        const url = this._urlEntry.get_text().trim().replace(/\/+$/, '');
        const token = this._tokenEntry.get_text().trim();
        const seconds = Number(this._intervalEntry.get_text().trim());
        if (!/^https?:\/\/\S+$/.test(url)) {
            this._setSettingsStatus('Informe uma URL válida (https://…)', true);
            return;
        }
        if (!token) {
            this._setSettingsStatus('Informe o token de acesso', true);
            return;
        }
        if (!Number.isFinite(seconds) || seconds < 30) {
            this._setSettingsStatus('O intervalo mínimo é 30 segundos', true);
            return;
        }
        const before = loadConfig();
        try {
            saveConfig({ url, token, refresh_seconds: Math.round(seconds), notifications: this._notifySwitch.checked });
        } catch (e) {
            this._setSettingsStatus(`Não foi possível salvar: ${e.message}`, true);
            return;
        }
        // Another account or server: drop old data so it neither shows nor triggers notifications.
        if (before.url !== url || before.token !== token) {
            this._data = null;
            this._previous = null;
            this._error = null;
            this._avatar.style = null;
        }
        this._setSettingsStatus('Configurações salvas', false);
        this._refresh(true);
    }

    // ---------- data ----------

    async _refresh(force = false) {
        if (this._loading && !force)
            return;
        if (force)
            this._reloadConfig();
        if (!this._client) {
            this._error = this._config.error;
            this._render();
            return;
        }
        this._loading = true;
        this._refreshButton.add_style_pseudo_class('active');
        const client = this._client;
        try {
            const data = await client.fetchAll();
            if (client !== this._client)
                return;
            for (const m of data.review)
                m.forReview = true;
            this._notifyChanges(data);
            // review MRs present on the first load don't count as new
            if (!this._seenReview)
                this._seenReview = new Set(data.review.map(m => m.id));
            this._failedJobs.clear();
            this._data = data;
            this._error = null;
            this._lastFetch = Date.now();
        } catch (e) {
            if (client !== this._client)
                return;
            this._error = e.message;
        } finally {
            if (client === this._client) {
                this._loading = false;
                this._refreshButton.remove_style_pseudo_class('active');
                this._render();
            }
        }
    }

    _notifyChanges(data) {
        const prev = this._previous;
        this._previous = new Map([...data.mine, ...data.review].map(m => [m.id, m]));
        if (!prev || !this._config.notifications)
            return;
        const me = data.user.username;

        for (const m of data.review) {
            if (!prev.has(m.id))
                this._notify('Novo MR para revisar', `${m.author} · ${m.projectShort} ${m.ref}\n${shortTitle(m)}`, m.url, this._links(m));
        }

        // Mine that left the open list: merged or closed
        const openIds = new Set(data.mine.map(m => m.id));
        for (const old of prev.values()) {
            if (!old.forReview && !openIds.has(old.id))
                this._notifyGone(old);
        }

        for (const m of data.mine) {
            const old = prev.get(m.id);
            if (!old)
                continue;
            const where = `${m.projectShort} ${m.ref} · ${shortTitle(m)}`;
            if (m.pipeline !== old.pipeline) {
                if (m.pipeline === 'failed')
                    this._notify('Pipeline falhou', where, m.pipelineUrl || m.url, this._links(m, true));
                else if (m.pipeline === 'success' && old.pipeline !== null)
                    this._notify('Pipeline passou', where, m.url, this._links(m));
            }
            if (m.approvedBy.length > old.approvedBy.length) {
                const who = m.approvedBy.filter(n => !old.approvedBy.includes(n)).join(', ');
                this._notify('MR aprovado', `${who} aprovou ${where}`, m.url, this._links(m));
            }
            if (m.conflicts && !old.conflicts)
                this._notify(`Conflito com ${m.target}`, `${where}\nPrecisa de rebase ou merge`, m.url, this._links(m));
            const newThread = m.threadsOpen && !old.threadsOpen;
            if (m.notes > old.notes || newThread)
                this._notifyComments(m, old, newThread, me);
        }
    }

    // Notification buttons: the pipeline (when asked and known) and the MR.
    _links(m, withPipeline = false) {
        const links = [];
        if (withPipeline && m.pipelineUrl)
            links.push(['Abrir pipeline', m.pipelineUrl]);
        links.push(['Abrir MR', m.url]);
        return links;
    }

    async _notifyGone(old) {
        const client = this._client;
        if (!client)
            return;
        try {
            const mr = await client.mergeRequest(old.projectId, old.iid);
            const where = `${old.projectShort} ${old.ref} · ${shortTitle(old)}`;
            if (mr.state === 'merged') {
                const by = mr.merged_by ? `\nMergeado por ${mr.merged_by.name}` : '';
                this._notify('MR mergeado', `${where}${by}`, old.url, [['Abrir MR', old.url]]);
            } else if (mr.state === 'closed') {
                this._notify('MR fechado', where, old.url, [['Abrir MR', old.url]]);
            }
        } catch (e) {
            // no access anymore or network error: stay quiet
        }
    }

    // Others' comments since the previous fetch; a newly opened thread wins the title.
    async _notifyComments(m, old, newThread, me) {
        const client = this._client;
        if (!client)
            return;
        const where = `${m.projectShort} ${m.ref} · ${shortTitle(m)}`;
        let fresh = [];
        try {
            const perPage = Math.min(30, Math.max(5, m.notes - old.notes + 5));
            const notes = await client.recentNotes(m.projectId, m.iid, perPage);
            const since = Date.parse(old.updatedAt);
            fresh = notes.filter(n => !n.system && n.author && n.author.username !== me &&
                Date.parse(n.created_at) > since);
        } catch (e) {
            fresh = [];
        }
        if (!fresh.length) {
            if (newThread)
                this._notify('Nova thread aberta', where, m.url, this._links(m));
            return;
        }
        const last = fresh[0];
        const snippet = last.body.replace(/\s+/g, ' ').trim();
        const quote = snippet.length > 140 ? `${snippet.slice(0, 139)}…` : snippet;
        let title;
        if (newThread)
            title = `${last.author.name} abriu uma thread`;
        else if (fresh.length > 1)
            title = `${fresh.length} novos comentários`;
        else
            title = `${last.author.name} comentou`;
        const noteUrl = `${m.url}#note_${last.id}`;
        this._notify(title, `${where}\n“${quote}”`, noteUrl, [['Ver comentário', noteUrl], ['Abrir MR', m.url]]);
    }

    _notify(title, body, url, actions = []) {
        if (!this._source) {
            this._source = new MessageTray.Source('GitLab MRs', 'mail-unread-symbolic');
            this._source.getIcon = () => Gio.icon_new_for_string(`${Me.path}/icons/merge-symbolic.svg`);
            this._source.connect('destroy', () => (this._source = null));
            Main.messageTray.add(this._source);
        }
        const n = new MessageTray.Notification(this._source, title, body);
        n.setTransient(false);
        n.connect('activated', () => openUri(url));
        for (const [text, link] of actions)
            n.addAction(text, () => openUri(link));
        this._source.showNotification(n);
    }

    // ---------- render ----------

    _render() {
        const d = this._data;
        const mine = d ? d.mine.length : 0;
        const review = d ? d.review.length : 0;

        // panel
        this._panelCount.text = d ? String(mine) : (this._error ? '!' : '');
        // red: some pipeline of mine failed; blue: some is running
        const failed = d && d.mine.some(m => m.pipeline === 'failed');
        const running = d && !failed && d.mine.some(m => m.pipeline === 'running');
        this._panelBox.remove_style_class_name('gmr-state-failed');
        this._panelBox.remove_style_class_name('gmr-state-running');
        if (failed)
            this._panelBox.add_style_class_name('gmr-state-failed');
        else if (running)
            this._panelBox.add_style_class_name('gmr-state-running');
        const unseen = d && this._seenReview ? d.review.filter(m => !this._seenReview.has(m.id)).length : 0;
        this._panelDot.visible = unseen > 0;
        this.accessible_name = `GitLab MRs: ${mine} abertos, ${review} para revisar${unseen ? `, ${unseen} novos` : ''}`;

        // header
        if (d && d.user) {
            const u = d.user;
            if (u.avatarPath)
                this._avatar.style = `background-image: url("file://${u.avatarPath}");`;
            else
                this._avatar.set_child(new St.Label({ text: (u.name || '?')[0], style_class: 'gmr-avatar-letter' }));
        }

        this._renderList();
    }

    _items() {
        if (!this._data)
            return [];
        return [...this._data.mine, ...this._data.review];
    }

    _renderChips(items) {
        this._chips.destroy_all_children();
        this._chips.visible = items.length > 0;
        for (const f of FILTERS) {
            const n = items.filter(f.test).length;
            if (f.key !== 'all' && n === 0) {
                if (this._filter === f.key)
                    this._filter = 'all';
                continue;
            }
            const box = new St.BoxLayout();
            box.add_child(new St.Label({ text: f.label, y_align: Clutter.ActorAlign.CENTER }));
            box.add_child(new St.Label({ text: String(n), style_class: 'gmr-chip-count', y_align: Clutter.ActorAlign.CENTER }));
            const chip = new St.Button({ style_class: 'gmr-chip', can_focus: true, child: box });
            if (this._filter === f.key)
                chip.add_style_pseudo_class('checked');
            chip.connect('clicked', () => {
                this._filter = this._filter === f.key ? 'all' : f.key;
                this._renderList();
            });
            this._chips.add_child(chip);
        }
    }

    _showEmpty(content) {
        const old = this._emptyBox.get_child();
        this._emptyBox.set_child(content);
        if (old)
            old.destroy();
        this._emptyBox.visible = Boolean(content);
        this._listArea.visible = !content;
    }

    _renderList() {
        this._list.destroy_all_children();
        const all = this._items();
        this._renderChips(all);
        // With nothing listed, the empty state carries its own "Atualizar" button.
        this._refreshButton.visible = all.length > 0;

        if (this._error && !this._data) {
            this._showEmpty(this._config.error
                ? this._emptyState('Configure o GitLab', this._error, 'settings')
                : this._emptyState('Não foi possível carregar', this._error, 'refresh'));
            return;
        }
        if (!this._data) {
            this._showEmpty(this._emptyState('Carregando merge requests…', '', null));
            return;
        }
        if (all.length === 0) {
            this._showEmpty(this._emptyState('Nenhum merge request aberto', this._error ? `Última atualização falhou: ${this._error}` : '', 'refresh'));
            return;
        }
        this._showEmpty(null);

        if (this._error) {
            const warn = new St.BoxLayout({ style_class: 'gmr-banner' });
            warn.add_child(new St.Icon({ gicon: asset('status-wait'), style_class: 'gmr-banner-icon' }));
            warn.add_child(label(`Última atualização falhou: ${this._error}`, 'gmr-banner-text', { x_expand: true }));
            this._list.add_child(warn);
        }

        const filter = FILTERS.find(f => f.key === this._filter) || FILTERS[0];
        const q = this._query;
        const items = all.filter(filter.test).filter(m => !q ||
            [m.title, m.project, m.source, m.target, m.ref, m.author].some(s => s && s.toLowerCase().includes(q)));

        if (items.length === 0) {
            const none = new St.BoxLayout({ vertical: true, style_class: 'gmr-noresults', x_expand: true });
            none.add_child(new St.Label({ text: 'Nenhum resultado', style_class: 'gmr-noresults-title', x_align: Clutter.ActorAlign.CENTER }));
            none.add_child(new St.Label({ text: 'Ajuste a busca ou o filtro.', style_class: 'gmr-noresults-body', x_align: Clutter.ActorAlign.CENTER }));
            this._list.add_child(none);
            return;
        }

        // group by project, in the user's order (MRs inside by most recent update)
        const groups = this._groupByProject(items);
        this._blocks = [];
        for (const project of this._orderProjects([...groups.keys()])) {
            const mrs = groups.get(project);
            const collapsed = this._collapsed.has(project);
            const header = this._groupHeader(project, mrs, collapsed);
            if (this._blocks.length)
                header.add_style_class_name('gmr-group-spaced');
            this._list.add_child(header);
            const block = { project, header, last: header };
            if (!collapsed) {
                for (const m of mrs) {
                    block.last = this._row(m);
                    this._list.add_child(block.last);
                }
            }
            this._blocks.push(block);
        }
    }

    // Map project -> MRs, most recently updated project first.
    _groupByProject(items) {
        const groups = new Map();
        for (const m of [...items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
            if (!groups.has(m.project))
                groups.set(m.project, []);
            groups.get(m.project).push(m);
        }
        return groups;
    }

    // Projects never reordered keep recency order on top, then the saved order.
    _orderProjects(projects) {
        const saved = this._projectOrder.filter(p => projects.includes(p));
        return [...projects.filter(p => !saved.includes(p)), ...saved];
    }

    // Moves `project` before visible block `index` (or after the last one), keeping
    // the relative order of projects hidden by the filter or without open MRs.
    _moveProject(project, index) {
        const visible = this._blocks.map(b => b.project);
        const from = visible.indexOf(project);
        if (from < 0 || index === from || index === from + 1)
            return;
        const order = this._orderProjects([...this._groupByProject(this._items()).keys()])
            .filter(p => p !== project);
        if (index < visible.length)
            order.splice(order.indexOf(visible[index]), 0, project);
        else
            order.splice(order.indexOf(visible[visible.length - 1]) + 1, 0, project);
        this._projectOrder = [...order, ...this._projectOrder.filter(p => !order.includes(p))];
        saveProjectOrder(this._projectOrder);
        this._renderList();
    }

    // ---------- drag to reorder ----------

    // St.Button grabs the pointer on press, so motion and release reach the
    // header itself even when the pointer is over other groups.
    _makeReorderable(header, project) {
        header.connect('button-press-event', (_a, event) => {
            if (event.get_button() === Clutter.BUTTON_PRIMARY && this._blocks.length > 1) {
                const [, y] = event.get_coords();
                this._drag = { header, project, startY: y, active: false, index: -1, indicator: null };
            }
            return Clutter.EVENT_PROPAGATE;
        });
        header.connect('motion-event', (_a, event) => {
            const d = this._drag;
            if (!d || d.header !== header)
                return Clutter.EVENT_PROPAGATE;
            const [, y] = event.get_coords();
            if (!d.active) {
                if (Math.abs(y - d.startY) < DRAG_THRESHOLD)
                    return Clutter.EVENT_PROPAGATE;
                d.active = true;
                header.add_style_class_name('gmr-group-dragging');
                d.indicator = new St.Widget({ style_class: 'gmr-drop-indicator', x_expand: true });
                global.display.set_cursor(Meta.Cursor.DND_MOVE);
            }
            this._autoScroll(y);
            this._placeIndicator(y);
            return Clutter.EVENT_STOP;
        });
        // Let the release through so St.Button drops its grab; 'clicked' checks the flag.
        header.connect('button-release-event', () => {
            if (this._drag && this._drag.header === header)
                this._endDrag(true);
            return Clutter.EVENT_PROPAGATE;
        });
        // Keyboard alternative: Alt+↑ / Alt+↓ on a focused project header.
        header.connect('key-press-event', (_a, event) => {
            if (!(event.get_state() & Clutter.ModifierType.MOD1_MASK))
                return Clutter.EVENT_PROPAGATE;
            const key = event.get_key_symbol();
            const at = this._blocks.findIndex(b => b.project === project);
            if (key === Clutter.KEY_Up && at > 0)
                this._moveProject(project, at - 1);
            else if (key === Clutter.KEY_Down && at < this._blocks.length - 1)
                this._moveProject(project, at + 2);
            else
                return Clutter.EVENT_PROPAGATE;
            const moved = this._blocks.find(b => b.project === project);
            if (moved)
                moved.header.grab_key_focus();
            return Clutter.EVENT_STOP;
        });
    }

    // Drop slot = first block whose vertical middle is below the pointer.
    _placeIndicator(y) {
        const d = this._drag;
        let index = this._blocks.length;
        for (let i = 0; i < this._blocks.length; i++) {
            const { header, last } = this._blocks[i];
            const [, top] = header.get_transformed_position();
            const [, lastTop] = last.get_transformed_position();
            if (y < (top + lastTop + last.height) / 2) {
                index = i;
                break;
            }
        }
        if (index === d.index)
            return;
        d.index = index;
        const from = this._blocks.findIndex(b => b.project === d.project);
        if (d.indicator.get_parent())
            this._list.remove_child(d.indicator);
        if (index === from || index === from + 1)
            return;
        if (index < this._blocks.length)
            this._list.insert_child_below(d.indicator, this._blocks[index].header);
        else
            this._list.insert_child_above(d.indicator, this._blocks[index - 1].last);
    }

    _autoScroll(y) {
        const adj = this._scroll.vscroll.adjustment;
        const [, top] = this._scroll.get_transformed_position();
        const bottom = top + this._scroll.height;
        if (y < top + AUTOSCROLL_EDGE)
            adj.value = Math.max(adj.lower, adj.value - 12);
        else if (y > bottom - AUTOSCROLL_EDGE)
            adj.value = Math.min(adj.upper - adj.page_size, adj.value + 12);
    }

    _endDrag(commit) {
        const d = this._drag;
        this._drag = null;
        if (!d || !d.active)
            return;
        this._suppressClick = true;
        global.display.set_cursor(Meta.Cursor.DEFAULT);
        if (d.indicator)
            d.indicator.destroy();
        // Re-render after St.Button has finished handling the release.
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._suppressClick = false;
            if (commit && d.index >= 0)
                this._moveProject(d.project, d.index);
            else
                this._renderList();
            return GLib.SOURCE_REMOVE;
        });
    }

    _groupHeader(project, mrs, collapsed) {
        const box = new St.BoxLayout({ x_expand: true, style_class: 'gmr-group-inner' });
        const names = new St.BoxLayout({ vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER });
        names.add_child(label(mrs[0].projectShort, 'gmr-group-name'));
        const ns = project.split('/').slice(0, -2).join('/');
        if (ns)
            names.add_child(label(ns, 'gmr-group-path'));
        box.add_child(names);
        if (collapsed)
            box.add_child(new St.Label({ text: String(mrs.length), style_class: 'gmr-group-count', y_align: Clutter.ActorAlign.CENTER }));
        box.add_child(new St.Icon({
            gicon: asset(collapsed ? 'chevron-down' : 'chevron-up'),
            style_class: 'gmr-group-chevron',
            y_align: Clutter.ActorAlign.CENTER,
        }));

        const button = new St.Button({
            style_class: collapsed ? 'gmr-group gmr-group-collapsed' : 'gmr-group',
            x_expand: true,
            can_focus: true,
            accessible_name: collapsed ? `Expandir ${project}` : `Recolher ${project}`,
            child: box,
        });
        button.connect('clicked', () => {
            if (this._suppressClick)
                return;
            if (collapsed)
                this._collapsed.delete(project);
            else
                this._collapsed.add(project);
            this._renderList();
        });
        this._makeReorderable(button, project);
        return button;
    }

    _emptyState(title, body, action) {
        const box = new St.BoxLayout({
            vertical: true,
            style_class: 'gmr-empty',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(new St.Icon({
            gicon: asset('empty-merge'),
            style_class: 'gmr-empty-icon',
            x_align: Clutter.ActorAlign.CENTER,
        }));
        const t = new St.Label({ text: title, style_class: 'gmr-empty-title', x_align: Clutter.ActorAlign.CENTER });
        t.clutter_text.line_wrap = true;
        t.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        t.clutter_text.line_alignment = Pango.Alignment.CENTER;
        box.add_child(t);
        if (body) {
            const b = new St.Label({ text: body, style_class: 'gmr-empty-body', x_align: Clutter.ActorAlign.CENTER });
            b.clutter_text.line_wrap = true;
            b.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            b.clutter_text.line_alignment = Pango.Alignment.CENTER;
            box.add_child(b);
        }
        if (action) {
            const toSettings = action === 'settings';
            const content = new St.BoxLayout({ style_class: 'gmr-action-content' });
            content.add_child(new St.Icon({ gicon: asset(toSettings ? 'settings-dark' : 'action-refresh'), style_class: 'gmr-action-icon' }));
            content.add_child(new St.Label({ text: toSettings ? 'Configurar' : 'Atualizar', y_align: Clutter.ActorAlign.CENTER }));
            const button = new St.Button({
                style_class: 'gmr-action',
                can_focus: true,
                x_align: Clutter.ActorAlign.CENTER,
                child: content,
            });
            if (this._loading && !toSettings)
                button.add_style_pseudo_class('active');
            button.connect('clicked', () => (toSettings ? this._showSettings(true) : this._refresh(true)));
            box.add_child(button);
        }
        return box;
    }

    _row(m) {
        const s = rowStatus(m);
        const row = new St.BoxLayout({ style_class: 'gmr-row-inner', x_expand: true });

        // status column: hover explains the status, click opens the pipeline
        const status = new St.Button({
            style_class: `gmr-status gmr-status-${s.cls}`,
            y_align: Clutter.ActorAlign.START,
            accessible_name: s.label,
            track_hover: true,
            child: new St.Icon({ gicon: asset(`status-${s.cls}`), style_class: 'gmr-status-icon' }),
        });
        if (m.pipelineUrl) {
            status.connect('clicked', () => {
                this.menu.close();
                openUri(m.pipelineUrl);
            });
        }
        status.connect('notify::hover', () => {
            if (!status.hover) {
                this._tooltip.hide(status);
                return;
            }
            this._tooltip.schedule(status, () => this._statusMarkup(m, s));
            this._loadFailedJobs(m, status);
        });
        status.connect('destroy', () => this._tooltip.hide(status));
        row.add_child(status);

        // main column
        const main = new St.BoxLayout({ vertical: true, x_expand: true, style_class: 'gmr-main' });
        main.add_child(label(`${m.ref} - ${shortTitle(m)}`, 'gmr-row-title'));

        const esc = t => GLib.markup_escape_text(t, -1);
        const meta = label('', 'gmr-branch');
        let markup = `<u>${esc(m.source)}</u>  <span foreground="#4e4e4e">para</span>  <u>${esc(m.target)}</u>`;
        if (m.forReview)
            markup += `  <span foreground="#4e4e4e">·</span>  <span font_family="Geist">${esc(m.author)}</span>`;
        meta.clutter_text.set_markup(markup);
        main.add_child(meta);
        row.add_child(main);

        // right column: time + approvals + comments; on hover, a copy-link button instead
        const side = new St.BoxLayout({ vertical: true, style_class: 'gmr-side', y_align: Clutter.ActorAlign.START });
        const info = new St.BoxLayout({ vertical: true, style_class: 'gmr-side-info', x_align: Clutter.ActorAlign.END, y_align: Clutter.ActorAlign.START });
        info.add_child(new St.Label({ text: relTime(m.updatedAt), style_class: 'gmr-time', x_align: Clutter.ActorAlign.END }));
        const extras = new St.BoxLayout({ style_class: 'gmr-side-extras', x_align: Clutter.ActorAlign.END });
        const approved = m.approvedBy.length;
        if (approved) {
            const tone = m.approvalsLeft === 0 ? 'green' : 'gray';
            extras.add_child(new St.Icon({
                gicon: asset(`approve-${approved > 1 ? 2 : 1}-${tone}`),
                style_class: 'gmr-approve-icon',
                y_align: Clutter.ActorAlign.CENTER,
            }));
        }
        if (m.notes) {
            const notes = new St.BoxLayout({ style_class: 'gmr-notes' });
            notes.add_child(new St.Icon({ gicon: asset('comments'), style_class: 'gmr-notes-icon', y_align: Clutter.ActorAlign.CENTER }));
            notes.add_child(new St.Label({ text: String(m.notes), y_align: Clutter.ActorAlign.CENTER }));
            extras.add_child(notes);
        }
        if (extras.get_n_children())
            info.add_child(extras);
        side.add_child(info);

        const copy = new St.Button({
            style_class: 'gmr-copy',
            can_focus: true,
            visible: false,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.START,
            accessible_name: 'Copiar link do MR',
            child: new St.Icon({ gicon: asset('copy'), style_class: 'gmr-copy-icon' }),
        });
        copy.connect('clicked', () => {
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, m.url);
            copy.child.gicon = asset('copied');
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1200, () => {
                if (copy.get_stage())
                    copy.child.gicon = asset('copy');
                return GLib.SOURCE_REMOVE;
            });
        });
        side.add_child(copy);
        row.add_child(side);

        const button = new St.Button({ style_class: 'gmr-row', x_expand: true, can_focus: true, child: row });
        button.connect('clicked', () => {
            this.menu.close();
            openUri(m.url);
        });
        const syncHover = () => {
            const on = button.hover || button.has_key_focus() || copy.has_key_focus();
            info.visible = !on;
            copy.visible = on;
        };
        button.connect('notify::hover', syncHover);
        for (const actor of [button, copy]) {
            actor.connect('key-focus-in', syncHover);
            actor.connect('key-focus-out', syncHover);
        }
        return button;
    }

    _statusMarkup(m, s) {
        const esc = t => GLib.markup_escape_text(t, -1);
        const jobs = m.pipelineId ? this._failedJobs.get(m.pipelineId) : null;
        const lines = statusDetails(m, jobs).filter(l => l !== s.label);
        return [`<b>${esc(s.label)}</b>`, ...lines.map(esc)].join('\n');
    }

    // Failed job names are fetched on first hover only (one request per pipeline).
    _loadFailedJobs(m, status) {
        if (m.pipeline !== 'failed' || !m.pipelineId || !this._client || this._failedJobs.has(m.pipelineId))
            return;
        this._failedJobs.set(m.pipelineId, undefined);
        this._client.failedJobs(m.projectId, m.pipelineId)
            .then(names => this._failedJobs.set(m.pipelineId, names))
            .catch(() => this._failedJobs.set(m.pipelineId, null))
            .finally(() => this._tooltip.refresh(status));
    }

    destroy() {
        this._endDrag(false);
        this._tooltip.destroy();
        if (this._timerId)
            GLib.source_remove(this._timerId);
        this._timerId = 0;
        if (this._client)
            this._client.destroy();
        this._client = null;
        if (this._source)
            this._source.destroy();
        super.destroy();
    }
});

class Extension {
    enable() {
        this._indicator = new MrIndicator();
        Main.panel.addToStatusArea('gitlab-mrs', this._indicator, 0, 'right');
    }

    disable() {
        this._indicator.destroy();
        this._indicator = null;
    }
}

function init() {
    return new Extension();
}
