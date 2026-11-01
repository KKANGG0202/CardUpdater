// Card Updater for SillyTavern
// Replaces a character card with a newer version in one click and keeps the
// user's chats, favorite flag, chat link and Tavern Helper character variables.
// The embedded lorebook is re-imported automatically (old one is backed up first).
//
// Safety notes:
// - This extension NEVER reads, writes, or deletes chat files.
// - Before every update the current card PNG is backed up (browser storage) for one-click rollback.
// - Nothing is downloaded or replaced without the user pressing a confirm button.

const MODULE = 'card_updater';
const FIELD = 'card_updater'; // stored in card: data.extensions.card_updater = { manifest_url }
const BACKUP_PREFIX = 'card_updater_backup:';
const LOG = '[Card Updater]';

const defaultSettings = Object.freeze({
    autoCheck: true,       // default for bots without their own setting
    backupLorebook: true,  // default for bots without their own setting
    perBot: {},            // { [avatar]: { autoCheck?: boolean, backupLorebook?: boolean } }
    creatorRepo: '',
});

const checkedThisSession = new Set();
let busy = false;

// ───────────────────────── helpers ─────────────────────────

const ctx = () => SillyTavern.getContext();

function getSettings() {
    const { extensionSettings } = ctx();
    if (!extensionSettings[MODULE]) {
        extensionSettings[MODULE] = structuredClone(defaultSettings);
    }
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(extensionSettings[MODULE], key)) {
            extensionSettings[MODULE][key] = structuredClone(defaultSettings[key]);
        }
    }
    return extensionSettings[MODULE];
}

/** Per-bot option (stored locally by avatar file name), falling back to the global default. */
function getBotOption(avatar, key) {
    const settings = getSettings();
    const own = settings.perBot?.[avatar]?.[key];
    return typeof own === 'boolean' ? own : !!settings[key];
}

function setBotOption(avatar, key, value) {
    const settings = getSettings();
    settings.perBot ??= {};
    settings.perBot[avatar] ??= {};
    settings.perBot[avatar][key] = !!value;
    ctx().saveSettingsDebounced();
}

function escapeHtml(text) {
    return String(text ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[ch]));
}

/** Returns { chid, char } for the currently opened single character, or null. */
function getCurrent() {
    const c = ctx();
    if (c.groupId || c.characterId === undefined || c.characterId === null) return null;
    const char = c.characters[c.characterId];
    if (!char) return null;
    return { chid: c.characterId, char };
}

async function getFullCharacter(chid) {
    const c = ctx();
    await c.unshallowCharacter(chid);
    return c.characters[chid];
}

function isGenerating() {
    return $('#mes_stop').is(':visible');
}

function compareVersions(a, b) {
    const parse = v => String(v ?? '').trim().replace(/^v/i, '').split(/[.\-+]/).map(x => parseInt(x, 10) || 0);
    const pa = parse(a), pb = parse(b);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
        const d = (pa[i] ?? 0) - (pb[i] ?? 0);
        if (d !== 0) return d > 0 ? 1 : -1;
    }
    return 0;
}

/** github.com/.../blob/... → raw.githubusercontent.com/... */
function toRawUrl(url) {
    const m = String(url).trim().match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/i);
    return m ? `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}` : String(url).trim();
}

/** Readable form of a URL for confirmation dialogs: host + decoded path. */
function hostOf(url) {
    try {
        const u = new URL(url);
        let path = u.pathname;
        try { path = decodeURIComponent(path); } catch { /* keep encoded */ }
        return `${u.host}${path}`;
    } catch {
        return url;
    }
}

// ───────────────────── card file parsing ─────────────────────

/** Reads the embedded card JSON from a PNG (ccv3 preferred, then chara). */
function readCardFromPng(buffer) {
    const bytes = new Uint8Array(buffer);
    const sig = [137, 80, 78, 71, 13, 10, 26, 10];
    if (!sig.every((b, i) => bytes[i] === b)) return null;

    const view = new DataView(buffer);
    const latin1 = new TextDecoder('latin1');
    const found = {};
    let pos = 8;
    while (pos + 8 <= bytes.length) {
        const length = view.getUint32(pos);
        const type = latin1.decode(bytes.subarray(pos + 4, pos + 8));
        const dataStart = pos + 8;
        if (type === 'tEXt') {
            const chunk = bytes.subarray(dataStart, dataStart + length);
            const sep = chunk.indexOf(0);
            if (sep > 0) {
                const keyword = latin1.decode(chunk.subarray(0, sep)).toLowerCase();
                if (keyword === 'ccv3' || keyword === 'chara') {
                    found[keyword] = latin1.decode(chunk.subarray(sep + 1));
                }
            }
        }
        if (type === 'IEND') break;
        pos = dataStart + length + 4; // + CRC
    }

    const b64 = found.ccv3 ?? found.chara;
    if (!b64) return null;
    const bin = atob(b64);
    const raw = Uint8Array.from(bin, ch => ch.charCodeAt(0));
    return JSON.parse(new TextDecoder('utf-8').decode(raw));
}

/** Returns the card's spec-v2/v3 style data object, or null if the file is not a card. */
async function readCardFile(file) {
    try {
        const name = file.name.toLowerCase();
        let card = null;
        if (name.endsWith('.png') || file.type === 'image/png') {
            card = readCardFromPng(await file.arrayBuffer());
        } else if (name.endsWith('.json')) {
            card = JSON.parse(await file.text());
        }
        if (!card) return null;
        const data = card.data ?? card;
        if (!data.name && !card.name) return null;
        return { ...data, name: data.name ?? card.name };
    } catch (err) {
        console.warn(LOG, 'Could not parse card file', err);
        return null;
    }
}

function fileExtension(file) {
    const m = file.name.match(/\.(\w+)$/);
    return m ? m[1].toLowerCase() : 'png';
}

// ───────────────────── backup / rollback ─────────────────────

async function backupCurrentCard(avatar, version) {
    const res = await fetch('/api/characters/export', {
        method: 'POST',
        headers: ctx().getRequestHeaders(),
        body: JSON.stringify({ format: 'png', avatar_url: avatar }),
    });
    if (!res.ok) throw new Error(`Export failed: ${res.status}`);
    const blob = await res.blob();
    await localforage.setItem(BACKUP_PREFIX + avatar, { blob, version: version || '', date: Date.now() });
}

async function getBackup(avatar) {
    try {
        return await localforage.getItem(BACKUP_PREFIX + avatar);
    } catch {
        return null;
    }
}

// ───────────────────── core update flow ─────────────────────

async function importCardFile(file, avatar) {
    const formData = new FormData();
    formData.append('avatar', file);
    formData.append('file_type', fileExtension(file));
    formData.append('user_name', ctx().name1);
    formData.append('preserved_name', avatar);

    const res = await fetch('/api/characters/import', {
        method: 'POST',
        body: formData,
        headers: ctx().getRequestHeaders({ omitContentType: true }),
        cache: 'no-cache',
    });
    if (!res.ok) throw new Error(`Import failed: ${res.status} ${res.statusText}`);
    const data = await res.json();
    if (data.error || data.file_name === undefined) throw new Error(`Import failed: ${data.error ?? 'no file name'}`);
}

async function mergeAttributes(avatar, update) {
    const res = await fetch('/api/characters/merge-attributes', {
        method: 'POST',
        headers: ctx().getRequestHeaders(),
        body: JSON.stringify({ avatar, ...update }),
    });
    if (!res.ok) throw new Error(`Saving kept fields failed: ${res.status}`);
}

/** Decides which lorebook name the card's embedded book goes into (keeps the user's current link). */
function getLorebookTarget(newData, oldWorld) {
    const book = newData.character_book;
    if (!book || !Array.isArray(book.entries)) return null;
    const names = ctx().getWorldInfoNames();
    return (oldWorld && names.includes(oldWorld)) ? oldWorld : (book.name || `${newData.name}'s Lorebook`);
}

/** Overwrites the target lorebook with the card's embedded one. */
async function syncLorebook(newData, target, avatar) {
    const book = newData.character_book;
    if (!target || !book) return;

    const c = ctx();
    const names = c.getWorldInfoNames();

    if (getBotOption(avatar, 'backupLorebook') && names.includes(target)) {
        const existing = await c.loadWorldInfo(target);
        if (existing) {
            await c.saveWorldInfo(`${target}_backup`, structuredClone(existing), true);
        }
    }

    const converted = c.convertCharacterBook(structuredClone(book));
    await c.saveWorldInfo(target, converted, true);
    await c.updateWorldInfoList();
    try { c.reloadWorldInfoEditor(target, false); } catch { /* editor not open */ }
}

/**
 * Replace the current character with `file`.
 * @param {File} file
 * @param {{ notes?: string, isRollback?: boolean }} [options]
 */
async function performUpdate(file, { notes = '', isRollback = false } = {}) {
    if (busy) return;
    const cur = getCurrent();
    if (!cur) {
        toastr.warning('봇 하나를 열어둔 상태에서 써주세요. (그룹 채팅은 안 돼요)', 'Card Updater');
        return;
    }
    if (isGenerating()) {
        toastr.warning('답변 생성 중에는 업데이트할 수 없어요. 생성이 끝난 뒤 다시 눌러주세요.', 'Card Updater');
        return;
    }

    const newData = await readCardFile(file);
    if (!newData) {
        toastr.error('이 파일에서 봇카드 데이터를 찾지 못했어요. PNG/JSON 봇카드가 맞는지 확인해주세요.', 'Card Updater');
        return;
    }

    const oldChar = await getFullCharacter(cur.chid);
    const avatar = oldChar.avatar;
    const oldVersion = oldChar.data?.character_version || '';
    const newVersion = newData.character_version || '';
    const nameDiffers = String(newData.name).trim() !== String(oldChar.name).trim();
    const hasBook = !!newData.character_book?.entries?.length;

    const { Popup } = ctx();
    const html = `
        <div class="card_updater_confirm">
            <p><b>${escapeHtml(oldChar.name)}</b> ${oldVersion ? `v${escapeHtml(oldVersion)}` : ''}
               → <b>${escapeHtml(newData.name)}</b> ${newVersion ? `v${escapeHtml(newVersion)}` : ''}</p>
            ${nameDiffers ? '<p class="card_updater_warn">⚠️ 새 카드의 이름이 지금 봇과 달라요. 다른 봇 카드가 아닌지 확인해주세요.</p>' : ''}
            ${notes ? `<div class="card_updater_notes"><b>업데이트 내용</b><br>${escapeHtml(notes).replace(/\n/g, '<br>')}</div>` : ''}
            <ul>
                <li>✅ 채팅 기록, 즐겨찾기, 태번헬퍼 캐릭터 변수는 그대로예요.</li>
                <li>🔄 카드 내용, 정규식, 스크립트${hasBook ? ', 로어북' : ''}이 새 버전으로 바뀌어요.</li>
                ${hasBook && getBotOption(avatar, 'backupLorebook') ? '<li>💾 기존 로어북은 <code>이름_backup</code>으로 복사해둬요.</li>' : ''}
                ${isRollback ? '' : '<li>↩️ 지금 카드는 백업해둬서 언제든 되돌릴 수 있어요.</li>'}
            </ul>
        </div>`;
    const ok = await Popup.show.confirm(isRollback ? '이전 버전으로 되돌릴까요?' : '봇을 업데이트할까요?', html, { okButton: isRollback ? '되돌리기' : '업데이트', cancelButton: '취소' });
    if (!ok) return;

    busy = true;
    const toast = toastr.info('업데이트 중이에요... 창을 닫지 말아주세요.', 'Card Updater', { timeOut: 0, extendedTimeOut: 0 });
    try {
        const c = ctx();
        const chatFile = oldChar.chat;
        const fav = !!(oldChar.fav || oldChar.data?.extensions?.fav);
        const oldVars = oldChar.data?.extensions?.tavern_helper?.variables;
        const oldWorld = oldChar.data?.extensions?.world;
        // Tavern Helper keeps already-running scripts in memory, so changed scripts need a page reload.
        const scriptsChanged = JSON.stringify(oldChar.data?.extensions?.tavern_helper?.scripts ?? [])
            !== JSON.stringify(newData.extensions?.tavern_helper?.scripts ?? []);

        // 0) Flush the current chat to disk first (we never touch it afterwards).
        if (typeof c.saveChat === 'function') await c.saveChat();

        // 1) Backup the current card (skip on rollback so the backup stays the previous one).
        if (!isRollback) {
            try {
                await backupCurrentCard(avatar, oldVersion);
            } catch (err) {
                console.error(LOG, err);
                toastr.error('지금 카드를 백업하지 못해서 안전하게 중단했어요. 아무것도 바뀌지 않았어요.', 'Card Updater');
                return;
            }
        }

        // 2) Replace the card file, keeping the same avatar file name (= same chat folder).
        const worldName = getLorebookTarget(newData, oldWorld);
        await importCardFile(file, avatar);

        // 3) Restore the fields import resets: chat link, favorite, TH variables, lorebook link.
        const extensions = { fav };
        if (oldVars && typeof oldVars === 'object') extensions.tavern_helper = { variables: oldVars };
        if (worldName) extensions.world = worldName;
        const update = { fav, data: { extensions } };
        if (chatFile) update.chat = chatFile;
        await mergeAttributes(avatar, update);

        // 4) Lorebook: overwrite with the new embedded book (old one copied to _backup first).
        await syncLorebook(newData, worldName, avatar);

        // 5) Refresh and reopen the same chat.
        await c.getCharacters();
        const newChid = ctx().characters.findIndex(ch => ch.avatar === avatar);
        if (newChid >= 0) {
            await ctx().unshallowCharacter(newChid);
            await ctx().selectCharacterById(newChid, { switchMenu: false });
            if (chatFile && ctx().getCurrentChatId() !== chatFile) {
                await ctx().openCharacterChat(chatFile);
            }
        }

        toastr.clear(toast);
        const verText = newVersion ? `v${newVersion}` : '새 버전';
        toastr.success(`${newData.name} → ${verText}${worldName ? ` (로어북: ${worldName})` : ''}`, isRollback ? '되돌리기 완료' : '업데이트 완료');
        checkedThisSession.delete(avatar);

        if (scriptsChanged) {
            const reload = await ctx().Popup.show.confirm('새로고침이 필요해요',
                `<p>태번헬퍼 스크립트가 바뀌었어요.</p>
                 <p>지금 돌아가는 건 예전 스크립트라서, <b>새로고침해야</b> 새 스크립트·상태창이 적용돼요.</p>
                 <p class="card_updater_small">채팅은 이미 저장돼 있어서 새로고침해도 괜찮아요.</p>`,
                { okButton: '지금 새로고침', cancelButton: '나중에' });
            if (reload) location.reload();
        }
    } catch (err) {
        console.error(LOG, err);
        toastr.clear(toast);
        toastr.error(`업데이트 중 문제가 생겼어요: ${escapeHtml(err.message)}<br>채팅 파일은 건드리지 않았어요. 🔄 메뉴의 "되돌리기"로 이전 카드를 복구할 수 있어요.`, 'Card Updater', { timeOut: 0, extendedTimeOut: 0, escapeHtml: false });
    } finally {
        if (toast) toastr.clear(toast);
        busy = false;
    }
}

// ───────────────────── online update ─────────────────────

async function fetchManifest(char) {
    const url = char?.data?.extensions?.[FIELD]?.manifest_url;
    if (!url) return null;
    const res = await fetch(toRawUrl(url), { cache: 'no-store' });
    if (!res.ok) throw new Error(`업데이트 정보를 못 받았어요 (${res.status})`);
    const manifest = await res.json();
    if (!manifest?.version || !manifest?.card_url) throw new Error('업데이트 정보(JSON)에 version 또는 card_url이 없어요');
    return manifest;
}

async function onlineUpdate() {
    const cur = getCurrent();
    if (!cur) return toastr.warning('봇 하나를 열어둔 상태에서 써주세요.', 'Card Updater');
    const char = await getFullCharacter(cur.chid);
    if (!char.data?.extensions?.[FIELD]?.manifest_url) {
        return toastr.info('이 봇에는 업데이트 주소가 없어요. 제작자가 설정해야 쓸 수 있어요. 대신 "파일로 업데이트"를 써주세요.', 'Card Updater');
    }

    let manifest;
    try {
        manifest = await fetchManifest(char);
    } catch (err) {
        return toastr.error(err.message, 'Card Updater');
    }

    const current = char.data?.character_version || '0';
    if (compareVersions(manifest.version, current) <= 0) {
        return toastr.success(`이미 최신 버전이에요 (v${current})`, 'Card Updater');
    }

    const cardUrl = toRawUrl(manifest.card_url);
    const { Popup } = ctx();
    const ok = await Popup.show.confirm('새 버전이 있어요',
        `<p>v${escapeHtml(current)} → <b>v${escapeHtml(manifest.version)}</b></p>
         <p>이 주소에서 받아올게요:<br><code style="word-break: break-all;">${escapeHtml(hostOf(cardUrl))}</code></p>
         <p class="card_updater_small">raw.githubusercontent.com은 깃헙이 파일 원본을 보내주는 공식 주소예요. 뒤에 붙은 아이디/저장소 이름을 확인해주세요.</p>
         <p class="card_updater_small">믿을 수 있는 제작자의 주소인지 확인해주세요.</p>`,
        { okButton: '받아오기', cancelButton: '취소' });
    if (!ok) return;

    let file;
    try {
        const res = await fetch(cardUrl, { cache: 'no-store' });
        if (!res.ok) throw new Error(`카드 파일을 못 받았어요 (${res.status})`);
        const blob = await res.blob();
        const isJson = /\.json(\?|$)/i.test(cardUrl);
        file = new File([blob], isJson ? 'update.json' : 'update.png', { type: isJson ? 'application/json' : 'image/png' });
    } catch (err) {
        console.error(LOG, err);
        return toastr.error(`${escapeHtml(err.message)}<br>깃헙이라면 raw 주소인지 확인해주세요.`, 'Card Updater', { escapeHtml: false });
    }
    await performUpdate(file, { notes: manifest.notes || '' });
}

async function autoCheck() {
    const cur = getCurrent();
    if (!cur) return;
    const avatar = cur.char.avatar;
    if (!getBotOption(avatar, 'autoCheck')) return;
    if (checkedThisSession.has(avatar)) return;
    checkedThisSession.add(avatar);

    try {
        const char = await getFullCharacter(cur.chid);
        if (!char.data?.extensions?.[FIELD]?.manifest_url) return;
        const manifest = await fetchManifest(char);
        const current = char.data?.character_version || '0';
        if (compareVersions(manifest.version, current) <= 0) return;

        toastr.info(`${char.name} v${manifest.version}이 나왔어요. 눌러서 업데이트하기`, '봇 업데이트 있어요', {
            timeOut: 12000,
            extendedTimeOut: 5000,
            onclick: () => onlineUpdate(),
        });
    } catch (err) {
        console.debug(LOG, 'auto check skipped', err);
    }
}

// ───────────────────── creator: release builder ─────────────────────

/**
 * Parses a GitHub repo / folder address.
 * Accepts: github.com/u/r, github.com/u/r/tree/branch/folder, or any other https folder URL.
 * Returns a function that builds the public URL of a file in that folder.
 */
function makeFileUrlBuilder(address) {
    const clean = String(address).trim().replace(/\.git$/i, '').replace(/\/+$/, '');
    const gh = clean.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)(?:\/(?:tree|blob)\/([^/]+)(\/.*)?)?$/i);
    if (gh) {
        const [, user, repo, branch = 'main', dir = ''] = gh;
        return name => `https://github.com/${user}/${repo}/blob/${branch}${dir}/${encodeURIComponent(name)}`;
    }
    return name => `${clean}/${encodeURIComponent(name)}`;
}

function suggestNextVersion(version) {
    const v = String(version ?? '').trim();
    if (!v) return '1.0';
    const m = v.match(/^(.*?)(\d+)([^\d]*)$/);
    if (!m) return `${v}.1`;
    return `${m[1]}${Number(m[2]) + 1}${m[3]}`;
}

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Client-side port of SillyTavern's server `convertWorldInfoToCharacterBook`.
 * ST only re-embeds the linked lorebook into the card when the character form is saved,
 * so lorebook-only edits would otherwise be missing from the exported card.
 */
function worldInfoToCharacterBook(name, entries) {
    const result = { entries: [], name };
    for (const index in entries) {
        const entry = entries[index];
        result.entries.push({
            id: entry.uid,
            keys: entry.key,
            secondary_keys: entry.keysecondary,
            comment: entry.comment,
            content: entry.content,
            constant: entry.constant,
            selective: entry.selective,
            insertion_order: entry.order,
            enabled: !entry.disable,
            position: entry.position == 0 ? 'before_char' : 'after_char',
            use_regex: true,
            extensions: {
                ...entry.extensions,
                position: entry.position,
                exclude_recursion: entry.excludeRecursion,
                display_index: entry.displayIndex,
                probability: entry.probability ?? null,
                useProbability: entry.useProbability ?? false,
                depth: entry.depth ?? 4,
                selectiveLogic: entry.selectiveLogic ?? 0,
                outlet_name: entry.outletName ?? '',
                group: entry.group ?? '',
                group_override: entry.groupOverride ?? false,
                group_weight: entry.groupWeight ?? null,
                prevent_recursion: entry.preventRecursion ?? false,
                delay_until_recursion: entry.delayUntilRecursion ?? false,
                scan_depth: entry.scanDepth ?? null,
                match_whole_words: entry.matchWholeWords ?? null,
                use_group_scoring: entry.useGroupScoring ?? false,
                case_sensitive: entry.caseSensitive ?? null,
                automation_id: entry.automationId ?? '',
                role: entry.role ?? 0,
                vectorized: entry.vectorized ?? false,
                sticky: entry.sticky ?? null,
                cooldown: entry.cooldown ?? null,
                delay: entry.delay ?? null,
                match_persona_description: entry.matchPersonaDescription ?? false,
                match_character_description: entry.matchCharacterDescription ?? false,
                match_character_personality: entry.matchCharacterPersonality ?? false,
                match_character_depth_prompt: entry.matchCharacterDepthPrompt ?? false,
                match_scenario: entry.matchScenario ?? false,
                match_creator_notes: entry.matchCreatorNotes ?? false,
                triggers: entry.triggers ?? [],
                ignore_budget: entry.ignoreBudget ?? false,
            },
        });
    }
    return result;
}

async function buildRelease() {
    const cur = getCurrent();
    if (!cur) return toastr.warning('봇 하나를 열어둔 상태에서 써주세요.', 'Card Updater');
    if (isGenerating()) return toastr.warning('답변 생성이 끝난 뒤 다시 눌러주세요.', 'Card Updater');

    const c = ctx();
    const settings = getSettings();
    const char = await getFullCharacter(cur.chid);
    const avatar = char.avatar;
    const baseName = avatar.replace(/\.png$/i, '');
    const oldVersion = char.data?.character_version || '';

    // 1) Repo address (remembered for next time)
    const repo = await c.Popup.show.input('📦 배포 파일 만들기 (1/3)',
        `<p>봇을 올릴 <b>깃헙 저장소 주소</b>를 붙여넣어 주세요.</p>
         <p class="card_updater_small">예: https://github.com/아이디/my-bots<br>한 번 넣으면 다음부터는 기억해요.</p>`,
        settings.creatorRepo || '');
    if (repo === null || repo === undefined || repo === false) return;
    const repoTrimmed = String(repo).trim();
    if (!/^https:\/\//i.test(repoTrimmed)) return toastr.error('https:// 로 시작하는 주소를 넣어주세요.', 'Card Updater');
    settings.creatorRepo = repoTrimmed;
    c.saveSettingsDebounced();

    // 2) Version
    const version = await c.Popup.show.input('📦 배포 파일 만들기 (2/3)',
        `<p>새 버전 이름을 적어주세요. <b>숫자로 시작</b>만 하면 자유예요.</p>
         <p class="card_updater_small">지금 버전: ${escapeHtml(oldVersion || '(없음)')} · 예: 1.2, 1.3-봄패치</p>`,
        suggestNextVersion(oldVersion));
    if (version === null || version === undefined || version === false) return;
    const newVersion = String(version).trim();
    if (!/^v?\d/i.test(newVersion)) return toastr.error('버전은 숫자로 시작해야 해요. (예: 1.2)', 'Card Updater');
    if (oldVersion && compareVersions(newVersion, oldVersion) <= 0) {
        const goOn = await c.Popup.show.confirm('버전이 안 올라갔어요',
            `<p>${escapeHtml(newVersion)}은(는) 지금 버전 ${escapeHtml(oldVersion)}보다 높지 않아서, 받는 사람에게 업데이트 알림이 안 떠요.</p><p>그래도 진행할까요?</p>`);
        if (!goOn) return;
    }

    // 3) Notes
    const notes = await c.Popup.show.input('📦 배포 파일 만들기 (3/3)',
        '<p>이번에 고친 내용을 적어주세요. (비워도 돼요)</p><p class="card_updater_small">받는 사람 업데이트 창에 보여져요.</p>',
        '', { rows: 5 });
    if (notes === null || notes === undefined || notes === false) return;

    const fileUrl = makeFileUrlBuilder(repoTrimmed);
    const pngName = `${baseName}.png`;
    const jsonName = `${baseName}.update.json`;
    const manifestUrl = fileUrl(jsonName);

    try {
        // Save version + update address into the card
        // Embed the CURRENT linked lorebook so lorebook-only edits are included.
        const releaseData = { character_version: newVersion };
        let bookCount = null;
        const worldName = char.data?.extensions?.world;
        if (worldName && c.getWorldInfoNames().includes(worldName)) {
            const world = await c.loadWorldInfo(worldName);
            if (world?.entries) {
                releaseData.character_book = worldInfoToCharacterBook(worldName, world.entries);
                bookCount = releaseData.character_book.entries.length;
            }
        }
        await mergeAttributes(avatar, { data: releaseData });
        if (releaseData.character_book) char.data.character_book = releaseData.character_book;
        char.data.character_version = newVersion;
        if (char.json_data) {
            const json = JSON.parse(char.json_data);
            if (json.data) json.data.character_version = newVersion;
            if (json.data && releaseData.character_book) json.data.character_book = releaseData.character_book;
            char.json_data = JSON.stringify(json);
            if (Number(cur.chid) === Number(ctx().characterId)) $('#character_json_data').val(char.json_data);
        }
        if (Number(cur.chid) === Number(ctx().characterId)) $('#character_version_textarea').val(newVersion);
        await c.writeExtensionField(cur.chid, FIELD, { manifest_url: manifestUrl });

        // Export the finished card
        const res = await fetch('/api/characters/export', {
            method: 'POST',
            headers: c.getRequestHeaders(),
            body: JSON.stringify({ format: 'png', avatar_url: avatar }),
        });
        if (!res.ok) throw new Error(`카드 내보내기 실패 (${res.status})`);
        const pngBlob = await res.blob();

        const manifest = { version: newVersion, card_url: fileUrl(pngName), notes: String(notes).trim() };
        const jsonBlob = new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' });

        // Downloads are triggered by button clicks (a real user gesture), so the
        // browser never blocks the second file as a "multiple downloads" attempt.
        const markDone = (event) => {
            const el = event?.currentTarget;
            if (el && !el.textContent.startsWith('✅')) el.textContent = `✅ ${el.textContent}`;
        };
        const downloadButtons = [
            { text: `🤖 봇카드 받기 (${pngName})`, classes: ['popup-button-ok'], action: (e) => { downloadBlob(pngBlob, pngName); markDone(e); } },
            { text: `📄 업데이트 정보 받기 (${jsonName})`, classes: ['popup-button-ok'], action: (e) => { downloadBlob(jsonBlob, jsonName); markDone(e); } },
        ];

        await c.Popup.show.text('📦 배포 파일 완성!',
            `<p>아래 버튼 <b>2개를 각각 눌러서</b> 파일을 받아주세요:</p>
             <ul class="card_updater_list">
                <li><code>${escapeHtml(pngName)}</code> (봇카드, v${escapeHtml(newVersion)}${bookCount !== null ? `, 로어북 ${bookCount}개 항목 포함` : ''})</li>
                <li><code>${escapeHtml(jsonName)}</code> (업데이트 정보)</li>
             </ul>
             <p><b>이제 할 일:</b> 깃헙 저장소 페이지에서 <b>Add file → Upload files</b>를 누르고, 두 파일을 끌어다 놓은 다음 <b>Commit changes</b>를 누르면 끝이에요.</p>
             <p class="card_updater_warn">⚠️ 다운로드 폴더에 같은 이름 파일이 이미 있으면 브라우저가 <code>(2)</code>를 붙여요. 올리기 전에 이름 끝의 <code> (2)</code>를 지우거나, 받기 전에 다운로드 폴더의 예전 파일을 지워주세요.</p>
             <p class="card_updater_small">파일 이름은 바꾸지 말아주세요. 같은 이름으로 올리면 예전 파일을 알아서 덮어써요.<br>
             사람들한테는 이 PNG를 나눠주면 돼요. 다음에 고칠 때도 이 버튼만 다시 누르면 돼요.</p>
             ${/^https:\/\/github\.com\//i.test(repoTrimmed) ? '' : '<p class="card_updater_warn">깃헙 주소가 아니라서, 그 주소에서 파일을 바로 받을 수 있는지 꼭 확인해주세요.</p>'}`,
            { customButtons: downloadButtons, okButton: '닫기' });
    } catch (err) {
        console.error(LOG, err);
        toastr.error(`배포 파일을 만들지 못했어요: ${err.message}`, 'Card Updater');
    }
}

// ───────────────────── menu & UI ─────────────────────

function pickFile() {
    return new Promise(resolve => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.png,.json,image/png,application/json';
        input.addEventListener('change', () => resolve(input.files?.[0] ?? null), { once: true });
        input.click();
    });
}

async function rollback() {
    const cur = getCurrent();
    if (!cur) return;
    const backup = await getBackup(cur.char.avatar);
    if (!backup?.blob) return toastr.info('이 봇은 아직 백업이 없어요.', 'Card Updater');
    const file = new File([backup.blob], 'backup.png', { type: 'image/png' });
    await performUpdate(file, { isRollback: true });
}

async function openMenu() {
    const cur = getCurrent();
    if (!cur) {
        toastr.warning('봇 하나를 열어둔 상태에서 써주세요. (그룹 채팅은 안 돼요)', 'Card Updater');
        return;
    }
    const char = await getFullCharacter(cur.chid);
    const { Popup, POPUP_TYPE } = ctx();
    const hasUrl = !!char.data?.extensions?.[FIELD]?.manifest_url;
    const backup = await getBackup(char.avatar);
    const version = char.data?.character_version;

    const backupText = backup?.blob
        ? `${backup.version ? `v${escapeHtml(backup.version)}` : '이전 버전'} · ${escapeHtml(new Date(backup.date).toLocaleString())}`
        : '아직 백업이 없어요';

    const root = document.createElement('div');
    root.className = 'cu-menu';
    root.innerHTML = `
        <div class="cu-head">
            <div class="cu-title">Card Updater</div>
            <div class="cu-bot">
                <span class="cu-bot-name">${escapeHtml(char.name)}</span>
                ${version ? `<span class="cu-chip">v${escapeHtml(version)}</span>` : ''}
            </div>
        </div>

        <div class="cu-tiles">
            <div class="cu-tile" data-action="file" tabindex="0">
                <i class="fa-solid fa-file-arrow-up"></i>
                <div class="cu-tile-title">파일로 업데이트</div>
                <div class="cu-tile-desc">새 봇카드 PNG 넣기</div>
            </div>
            <div class="cu-tile ${hasUrl ? '' : 'cu-disabled'}" data-action="online" tabindex="0"
                 title="${hasUrl ? '' : '제작자가 업데이트 주소를 넣은 봇만 쓸 수 있어요'}">
                <i class="fa-solid fa-cloud-arrow-down"></i>
                <div class="cu-tile-title">온라인 업데이트</div>
                <div class="cu-tile-desc">${hasUrl ? '최신 버전 확인하기' : '업데이트 주소 없음'}</div>
            </div>
        </div>

        <div class="cu-list">
            <div class="cu-row ${backup?.blob ? '' : 'cu-disabled'}" data-action="rollback" tabindex="0">
                <i class="fa-solid fa-clock-rotate-left"></i>
                <div class="cu-row-text">
                    <div class="cu-row-title">이전 버전으로 되돌리기</div>
                    <div class="cu-row-desc">${backupText}</div>
                </div>
                <i class="fa-solid fa-chevron-right cu-arrow"></i>
            </div>
            <div class="cu-row" data-action="release" tabindex="0">
                <i class="fa-solid fa-box-open"></i>
                <div class="cu-row-text">
                    <div class="cu-row-title">배포 파일 만들기</div>
                    <div class="cu-row-desc">제작자용 · 새 버전 올리기</div>
                </div>
                <i class="fa-solid fa-chevron-right cu-arrow"></i>
            </div>
        </div>

        <div class="cu-settings">
            <div class="cu-settings-label">이 봇 설정</div>
            <label class="cu-toggle">
                <input type="checkbox" data-setting="autoCheck" ${getBotOption(char.avatar, 'autoCheck') ? 'checked' : ''}>
                <span>봇을 열 때 새 버전 자동 확인</span>
            </label>
            <label class="cu-toggle">
                <input type="checkbox" data-setting="backupLorebook" ${getBotOption(char.avatar, 'backupLorebook') ? 'checked' : ''}>
                <span>로어북 덮어쓰기 전 _backup 만들기</span>
            </label>
        </div>

        <div class="cu-foot">채팅 기록은 업데이트해도 그대로예요.</div>
    `;

    const popup = new Popup(root, POPUP_TYPE.TEXT, null, { okButton: '닫기', allowVerticalScrolling: true });

    // Settings save immediately on change.
    root.querySelectorAll('input[data-setting]').forEach(input => {
        input.addEventListener('change', () => {
            setBotOption(char.avatar, input.dataset.setting, input.checked);
        });
    });

    const run = (action) => {
        switch (action) {
            case 'file': {
                // Open the file picker inside the click handler so the browser treats it as a user action.
                const picked = pickFile();
                popup.completeCancelled();
                picked.then(file => file && performUpdate(file));
                break;
            }
            case 'online': popup.completeCancelled().then(() => onlineUpdate()); break;
            case 'rollback': popup.completeCancelled().then(() => rollback()); break;
            case 'release': popup.completeCancelled().then(() => buildRelease()); break;
        }
    };

    root.querySelectorAll('[data-action]').forEach(el => {
        const handler = () => {
            if (el.classList.contains('cu-disabled')) {
                if (el.dataset.action === 'online') toastr.info('이 봇에는 업데이트 주소가 없어요. "파일로 업데이트"를 써주세요.', 'Card Updater');
                return;
            }
            run(el.dataset.action);
        };
        el.addEventListener('click', handler);
        el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handler(); } });
    });

    await popup.show();
}

function addButton() {
    if (document.getElementById('card_updater_button')) return;
    const block = document.querySelector('#avatar_controls .form_create_bottom_buttons_block');
    if (!block) {
        console.warn(LOG, 'Character panel buttons not found');
        return;
    }
    const btn = document.createElement('div');
    btn.id = 'card_updater_button';
    btn.className = 'menu_button fa-solid fa-rotate';
    btn.title = 'Card Updater';
    btn.addEventListener('click', () => openMenu().catch(err => {
        console.error(LOG, err);
        toastr.error(err.message, 'Card Updater');
    }));
    const fav = block.querySelector('#favorite_button');
    if (fav) fav.after(btn); else block.prepend(btn);
}

// ───────────────── keep embedded lorebook in sync ─────────────────
// SillyTavern only re-embeds the linked lorebook into the card when the character
// form is saved. Mirror lorebook edits into every linked card so that ST's normal
// Export button (and manual sharing) always contains the latest lorebook.

const bookSyncTimers = new Map();

function scheduleBookSync(name, data) {
    if (!name || !data?.entries) return;
    clearTimeout(bookSyncTimers.get(name));
    bookSyncTimers.set(name, setTimeout(() => {
        bookSyncTimers.delete(name);
        syncBookIntoCards(name, data).catch(err => console.warn(LOG, 'lorebook sync failed', err));
    }, 1500));
}

async function syncBookIntoCards(name, data) {
    if (busy) return; // an update is running; it handles the lorebook itself
    const c = ctx();
    const linked = c.characters.filter(ch => ch?.data?.extensions?.world === name);
    if (!linked.length) return;

    const book = worldInfoToCharacterBook(name, data.entries);
    for (const char of linked) {
        await mergeAttributes(char.avatar, { data: { character_book: book } });
        if (!char.shallow && char.data) {
            char.data.character_book = structuredClone(book);
            if (char.json_data) {
                const json = JSON.parse(char.json_data);
                if (json.data) json.data.character_book = structuredClone(book);
                char.json_data = JSON.stringify(json);
            }
        }
    }
    const cur = getCurrent();
    if (cur && linked.includes(cur.char) && cur.char.json_data) {
        $('#character_json_data').val(cur.char.json_data);
    }
    console.debug(LOG, `Embedded lorebook "${name}" into ${linked.length} card(s)`);
}

// ───────────────────── init ─────────────────────

(function init() {
    const { eventSource, event_types } = ctx();
    eventSource.on(event_types.APP_READY, () => {
        getSettings();
        addButton();
        console.log(LOG, 'Loaded');
    });
    eventSource.on(event_types.WORLDINFO_UPDATED, (name, data) => scheduleBookSync(name, data));
    eventSource.on(event_types.CHAT_CHANGED, () => {
        addButton();
        setTimeout(() => autoCheck(), 1500);
    });
})();
