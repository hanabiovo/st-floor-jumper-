(() => {
    'use strict';

    const EXT_ID = 'floor_jumper';
    const METADATA_KEY = 'floor_jumper_bookmarks';
    const POS_STORAGE_KEY = 'st_floor_jumper_window_pos';
    const AUTO_CLOSE_STORAGE_KEY = 'st_floor_jumper_auto_close';
    const ROW_HEIGHT = 58;
    const OVERSCAN = 6;
    const PREVIEW_MAX_LEN = 72;

    function loadAutoClosePref() {
        try {
            const val = localStorage.getItem(AUTO_CLOSE_STORAGE_KEY);
            return val === null ? true : val === '1';
        } catch {
            return true;
        }
    }

    const state = {
        isOpen: false,
        filter: 'all',      // 'all' | 'user' | 'bot' | 'bookmark' | 'hidden'
        query: '',
        reverseOrder: false,
        autoClose: loadAutoClosePref(),
        batchMode: false,
        rangeMode: false,
        rangeAnchorFloor: null,
        lastClickedFloor: null,
        selectedFloors: new Set(),
        keptInHiddenTab: new Set(),
        filteredIndices: [],
        lastJumpedIndex: null,
        rafId: null,
        searchTimer: null,
        noticeTimer: null,
        isJumping: false,
        isUpdatingVisibility: false,
    };

    /** @type {Record<string, HTMLElement | null>} */
    const dom = {};

    function getContext() {
        return window.SillyTavern?.getContext?.() ?? null;
    }

    function getChat() {
        const ctx = getContext();
        return Array.isArray(ctx?.chat) ? ctx.chat : [];
    }

    function getBookmarks() {
        const ctx = getContext();
        if (!ctx?.chatMetadata) return {};
        const raw = ctx.chatMetadata[METADATA_KEY];
        return raw && typeof raw === 'object' ? raw : {};
    }

    function setBookmark(index, note) {
        const ctx = getContext();
        if (!ctx?.chatMetadata) return;
        if (!ctx.chatMetadata[METADATA_KEY] || typeof ctx.chatMetadata[METADATA_KEY] !== 'object') {
            ctx.chatMetadata[METADATA_KEY] = {};
        }
        ctx.chatMetadata[METADATA_KEY][String(index)] = {
            note: String(note ?? '').trim(),
            updatedAt: Date.now(),
        };
        ctx.saveMetadataDebounced?.();
    }

    function removeBookmark(index) {
        const ctx = getContext();
        const map = ctx?.chatMetadata?.[METADATA_KEY];
        if (!map || typeof map !== 'object') return;
        delete map[String(index)];
        ctx.saveMetadataDebounced?.();
    }

    function isBookmarked(index) {
        const map = getBookmarks();
        return Object.prototype.hasOwnProperty.call(map, String(index));
    }

    function getBookmarkNote(index) {
        const entry = getBookmarks()[String(index)];
        return typeof entry === 'string' ? entry : (entry?.note || '');
    }

    /** 将消息正文轻量化为单行纯文本摘要 */
    function toPlainPreview(rawText) {
        if (!rawText) return '（空消息）';
        // 只截取前段再清理，避免超长消息正则耗时
        const slice = rawText.length > 400 ? rawText.slice(0, 400) : rawText;
        const cleaned = slice
            .replace(/<[^>]+>/g, ' ')
            .replace(/[*_`~#>]+/g, '')
            .replace(/\s+/g, ' ')
            .trim();
        if (!cleaned) return '（无文本内容）';
        return cleaned.length > PREVIEW_MAX_LEN
            ? cleaned.slice(0, PREVIEW_MAX_LEN) + '…'
            : cleaned;
    }

    function escapeHtml(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    /** 获取当前聊天视口顶部最接近的楼层号 */
    function getCurrentVisibleFloor() {
        const chatEl = document.getElementById('chat');
        if (!chatEl) return state.lastJumpedIndex ?? 0;

        const containerTop = chatEl.getBoundingClientRect().top;
        const mesEls = chatEl.querySelectorAll('.mes[mesid]');
        let bestId = null;
        let bestDist = Infinity;

        for (let i = 0; i < mesEls.length; i++) {
            const el = mesEls[i];
            const rect = el.getBoundingClientRect();
            const dist = Math.abs(rect.top - containerTop);
            if (dist < bestDist) {
                bestDist = dist;
                bestId = Number(el.getAttribute('mesid'));
            }
            if (rect.top > containerTop + 40 && bestId !== null) break;
        }
        return Number.isFinite(bestId) ? bestId : (state.lastJumpedIndex ?? 0);
    }

    /** 短暂高亮目标楼层 */
    function flashElement(el) {
        if (!(el instanceof HTMLElement)) return;
        el.classList.remove('fj_jump_flash');
        void el.offsetWidth;
        el.classList.add('fj_jump_flash');
        setTimeout(() => el.classList.remove('fj_jump_flash'), 1600);
    }

    /** 直接滚动到已渲染的 DOM 元素 */
    function scrollToRenderedFloor(index) {
        const chatEl = document.getElementById('chat');
        const mesEl = document.querySelector(`#chat .mes[mesid="${index}"]`);
        if (!(chatEl instanceof HTMLElement) || !(mesEl instanceof HTMLElement)) {
            return false;
        }
        const elementRect = mesEl.getBoundingClientRect();
        const containerRect = chatEl.getBoundingClientRect();
        const targetTop = elementRect.top - containerRect.top + chatEl.scrollTop;

        chatEl.scrollTo({
            top: Math.max(0, targetTop),
            behavior: 'smooth',
        });
        flashElement(mesEl);
        return true;
    }

    /** 等待浏览器把加载提示真正合成并绘制到屏幕上，再开始重渲染 */
    function nextPaint() {
        return new Promise((resolve) => {
            requestAnimationFrame(() => {
                setTimeout(resolve, 40);
            });
        });
    }

    /** 插件自带轻提示 / 加载状态条（替代原生 toastr） */
    function showNotice(text, options = {}) {
        const { loading = false, type = 'success', duration = 1600 } = options;
        if (!dom.notice || !dom.noticeIcon || !dom.noticeText) return;

        clearTimeout(state.noticeTimer);
        state.noticeTimer = null;

        if (loading) {
            dom.noticeIcon.className = 'fa-solid fa-spinner fa-spin fj_notice_icon';
            dom.notice.classList.add('fj_notice_instant');
        } else {
            dom.notice.classList.remove('fj_notice_instant');
            dom.noticeIcon.className = type === 'info'
                ? 'fa-solid fa-circle-info fj_notice_icon'
                : 'fa-solid fa-check fj_notice_icon';
        }

        dom.noticeText.textContent = text;
        dom.notice.classList.add('fj_notice_visible');
        if (loading) {
            // 强制刷新样式，确保首帧即满不透明度显示
            void dom.notice.offsetWidth;
        }

        if (!loading && duration > 0) {
            state.noticeTimer = setTimeout(() => {
                dom.notice?.classList.remove('fj_notice_visible');
            }, duration);
        }
    }

    /** 跳转到指定楼层（自动处理未渲染历史楼层的加载） */
    async function jumpToFloor(rawIndex) {
        const chat = getChat();
        if (!chat.length) {
            updateFooterStatus('当前没有聊天记录');
            showNotice('当前没有聊天记录', { type: 'info' });
            return;
        }

        const index = Number(rawIndex);
        if (!Number.isInteger(index) || index < 0 || index >= chat.length) {
            const msg = `请输入有效楼层号（0 ~ ${chat.length - 1}）`;
            updateFooterStatus(msg);
            showNotice(msg, { type: 'info', duration: 2000 });
            return;
        }

        if (state.isJumping) return;
        state.isJumping = true;

        try {
            state.lastJumpedIndex = index;
            const alreadyRendered = Boolean(document.querySelector(`#chat .mes[mesid="${index}"]`));

            if (state.autoClose && state.isOpen) {
                toggleWindow(false);
            }

            // 1. 已渲染在页面中：直接平滑滚动，零开销
            if (alreadyRendered && scrollToRenderedFloor(index)) {
                updateFooterStatus(`已定位到 #${index}`);
                showNotice(`已跳转到 #${index}`);
                return;
            }

            // 2. 未渲染：先画出加载动画，再触发酒馆加载历史楼层
            updateFooterStatus(`正在加载并跳转到 #${index}…`);
            showNotice(`正在加载历史楼层并跳转到 #${index}…`, { loading: true });
            await nextPaint();

            const ctx = getContext();
            if (typeof ctx?.executeSlashCommandsWithOptions === 'function') {
                await ctx.executeSlashCommandsWithOptions(`/chat-jump ${index}`, {
                    handleExecutionErrors: false,
                });
                if (scrollToRenderedFloor(index)) {
                    updateFooterStatus(`已加载并定位到 #${index}`);
                    showNotice(`已跳转到 #${index}`);
                    return;
                }
            }

            // 3. 兼容旧版酒馆兜底：循环触发“显示更多消息”按钮
            for (let attempt = 0; attempt < 40; attempt++) {
                const loadMoreBtn = document.getElementById('show_more_messages');
                if (!loadMoreBtn) break;
                loadMoreBtn.click();
                await new Promise(r => setTimeout(r, 120));
                if (scrollToRenderedFloor(index)) {
                    updateFooterStatus(`已加载并定位到 #${index}`);
                    showNotice(`已跳转到 #${index}`);
                    return;
                }
            }

            updateFooterStatus(`定位 #${index} 失败`);
            showNotice(`未能定位到 #${index}，请尝试手动加载历史消息`, { type: 'info', duration: 2400 });
        } finally {
            state.isJumping = false;
        }
    }

    /** 跳转到上一条 / 下一条用户消息 */
    function jumpAdjacentUserMessage(direction) {
        const chat = getChat();
        if (!chat.length) return;

        const current = getCurrentVisibleFloor();
        let target = -1;

        if (direction < 0) {
            for (let i = Math.min(current - 1, chat.length - 1); i >= 0; i--) {
                if (chat[i]?.is_user) {
                    target = i;
                    break;
                }
            }
        } else {
            for (let i = Math.max(current + 1, 0); i < chat.length; i++) {
                if (chat[i]?.is_user) {
                    target = i;
                    break;
                }
            }
        }

        if (target === -1) {
            const msg = direction < 0 ? '前面没有更早的用户消息了' : '后面没有更新的用户消息了';
            updateFooterStatus(msg);
            showNotice(msg, { type: 'info' });
            return;
        }
        jumpToFloor(target);
    }

    /** 快捷/批量隐藏或显示楼层（直接复用酒馆原生状态并单次保存，零卡顿） */
    async function setFloorsHidden(floorIndices, hide) {
        const ctx = getContext();
        const chat = getChat();
        if (!ctx || !chat.length || !floorIndices.length || state.isUpdatingVisibility) return;

        state.isUpdatingVisibility = true;
        try {
            const uniqueValid = [];
            const seen = new Set();
            for (let i = 0; i < floorIndices.length; i++) {
                const idx = Number(floorIndices[i]);
                if (!Number.isInteger(idx) || idx < 0 || idx >= chat.length || seen.has(idx)) continue;
                seen.add(idx);
                uniqueValid.push(idx);
            }
            if (!uniqueValid.length) return;

            let changed = 0;
            for (let i = 0; i < uniqueValid.length; i++) {
                const idx = uniqueValid[i];
                const msg = chat[idx];
                if (!msg) continue;
                const nextHidden = Boolean(hide);
                if (Boolean(msg.is_system) !== nextHidden) {
                    changed++;
                }
                msg.is_system = nextHidden;

                // 在“已隐藏”分类下取消隐藏时，临时保留在当前列表中防误触
                if (state.filter === 'hidden' && !nextHidden) {
                    state.keptInHiddenTab.add(idx);
                }

                const mesEl = document.querySelector(`#chat .mes[mesid="${idx}"]`);
                if (mesEl instanceof HTMLElement) {
                    mesEl.setAttribute('is_system', String(nextHidden));
                }
            }

            ctx.swipe?.refresh?.();
            await ctx.saveChat?.();

            const actionLabel = hide ? '隐藏' : '显示';
            const noticeText = uniqueValid.length === 1
                ? `已${actionLabel} #${uniqueValid[0]}`
                : (changed > 0
                    ? `已${actionLabel} ${uniqueValid.length} 个楼层`
                    : `所选 ${uniqueValid.length} 个楼层均已是${actionLabel}状态`);

            updateFooterStatus(noticeText);
            showNotice(noticeText);
            rebuildFilteredList(false);
        } finally {
            state.isUpdatingVisibility = false;
        }
    }

    /** 按当前列表顺序连选两个楼层之间的所有楼层 */
    function selectRangeBetween(floorA, floorB) {
        const list = state.filteredIndices;
        const posA = list.indexOf(floorA);
        const posB = list.indexOf(floorB);

        if (posA !== -1 && posB !== -1) {
            const start = Math.min(posA, posB);
            const end = Math.max(posA, posB);
            for (let p = start; p <= end; p++) {
                state.selectedFloors.add(list[p]);
            }
            return end - start + 1;
        }

        const minFloor = Math.min(floorA, floorB);
        const maxFloor = Math.max(floorA, floorB);
        let added = 0;
        for (let p = 0; p < list.length; p++) {
            const f = list[p];
            if (f >= minFloor && f <= maxFloor) {
                state.selectedFloors.add(f);
                added++;
            }
        }
        return added;
    }

    function setBatchMode(enabled) {
        state.batchMode = Boolean(enabled);
        if (!state.batchMode) {
            state.rangeMode = false;
            state.rangeAnchorFloor = null;
            state.lastClickedFloor = null;
            state.selectedFloors.clear();
        }
        updateBatchUI();
        renderVisibleRows();
    }

    function updateBatchUI() {
        if (!dom.batchToggle || !dom.batchBar) return;

        const count = state.selectedFloors.size;
        dom.batchToggle.classList.toggle('fj_active', state.batchMode);
        dom.batchBar.classList.toggle('fj_hidden', !state.batchMode);

        if (dom.rangeBtn) {
            dom.rangeBtn.classList.toggle('fj_active', state.rangeMode);
        }
        if (dom.batchHideBtn) {
            dom.batchHideBtn.disabled = count === 0;
            dom.batchHideBtn.innerHTML = `<i class="fa-solid fa-eye-slash"></i><span>隐藏${count ? ` (${count})` : ''}</span>`;
        }
        if (dom.batchShowBtn) {
            dom.batchShowBtn.disabled = count === 0;
            dom.batchShowBtn.innerHTML = `<i class="fa-regular fa-eye"></i><span>显示${count ? ` (${count})` : ''}</span>`;
        }
        if (dom.batchClearBtn) {
            dom.batchClearBtn.disabled = count === 0;
        }
        if (dom.batchHint) {
            if (state.rangeMode) {
                dom.batchHint.textContent = state.rangeAnchorFloor === null
                    ? '连选模式：先点起始楼层，再点终点楼层'
                    : `连选起点 #${state.rangeAnchorFloor}，请点击终点楼层`;
            } else {
                dom.batchHint.textContent = count > 0
                    ? `已选 ${count} 楼 · 可继续点选或切连选`
                    : '点击楼层勾选，桌面端支持 Shift 连选';
            }
        }
    }

    /** 重建筛选后的楼层索引数组（仅存数字索引，内存极小） */
    function rebuildFilteredList(resetScroll = false) {
        if (!state.isOpen) return;

        const chat = getChat();
        const bookmarks = getBookmarks();
        const q = state.query.trim().toLowerCase();
        const numericQuery = q.startsWith('#') ? q.slice(1) : q;
        const isPureNumber = numericQuery !== '' && /^\d+$/.test(numericQuery);

        const result = [];
        let hiddenCount = 0;
        for (let i = 0; i < chat.length; i++) {
            const msg = chat[i];
            if (!msg) continue;

            const isHidden = Boolean(msg.is_system);
            if (isHidden) hiddenCount++;

            if (state.filter === 'user' && !msg.is_user) continue;
            if (state.filter === 'bot' && msg.is_user) continue;
            if (state.filter === 'bookmark' && !Object.prototype.hasOwnProperty.call(bookmarks, String(i))) continue;
            if (state.filter === 'hidden' && !isHidden && !state.keptInHiddenTab.has(i)) continue;

            if (q) {
                const floorMatch = isPureNumber && String(i).includes(numericQuery);
                const nameMatch = (msg.name || '').toLowerCase().includes(q);
                const noteMatch = getBookmarkNote(i).toLowerCase().includes(q);
                const bodyMatch = (msg.mes || '').toLowerCase().includes(q);
                if (!floorMatch && !nameMatch && !noteMatch && !bodyMatch) continue;
            }

            result.push(i);
        }

        if (state.reverseOrder) {
            result.reverse();
        }

        state.filteredIndices = result;

        // 清理已越界的选中项
        if (state.selectedFloors.size > 0) {
            for (const f of state.selectedFloors) {
                if (f < 0 || f >= chat.length) state.selectedFloors.delete(f);
            }
        }

        // 更新顶部统计与输入框范围提示
        const bookmarkCount = Object.keys(bookmarks).length;
        if (dom.stats) {
            const parts = [`共${chat.length}楼`];
            if (hiddenCount > 0) parts.push(`隐${hiddenCount}`);
            if (bookmarkCount > 0) parts.push(`签${bookmarkCount}`);
            dom.stats.textContent = parts.join(' · ');
        }
        if (dom.jumpInput) {
            dom.jumpInput.max = String(Math.max(0, chat.length - 1));
            dom.jumpInput.placeholder = chat.length ? `0~${chat.length - 1}` : '楼层号';
        }
        if (dom.footerCount) {
            dom.footerCount.textContent = `匹配 ${result.length} / ${chat.length} 楼`;
        }

        // 更新虚拟列表总高度
        if (dom.spacer) {
            dom.spacer.style.height = `${result.length * ROW_HEIGHT}px`;
        }
        if (resetScroll && dom.viewport) {
            dom.viewport.scrollTop = 0;
        }

        updateBatchUI();
        renderVisibleRows();
    }

    /** 虚拟滚动渲染：只生成当前可视区域 + 上下缓冲的行 */
    function renderVisibleRows() {
        if (!state.isOpen || !dom.viewport || !dom.items) return;

        const chat = getChat();
        const list = state.filteredIndices;
        const total = list.length;

        if (total === 0) {
            dom.items.style.transform = 'translateY(0px)';
            dom.items.innerHTML = `<div class="fj_empty">${
                chat.length === 0 ? '当前没有聊天记录' : '没有符合条件的楼层'
            }</div>`;
            return;
        }

        const scrollTop = dom.viewport.scrollTop;
        const viewHeight = dom.viewport.clientHeight || 360;

        const startIdx = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
        const endIdx = Math.min(total - 1, Math.ceil((scrollTop + viewHeight) / ROW_HEIGHT) + OVERSCAN);

        dom.items.style.transform = `translateY(${startIdx * ROW_HEIGHT}px)`;

        let html = '';
        for (let pos = startIdx; pos <= endIdx; pos++) {
            const floorIndex = list[pos];
            const msg = chat[floorIndex];
            if (!msg) continue;

            const isUser = Boolean(msg.is_user);
            const isHidden = Boolean(msg.is_system);
            const isSelected = state.batchMode && state.selectedFloors.has(floorIndex);
            const isAnchor = state.batchMode && state.rangeMode && state.rangeAnchorFloor === floorIndex;
            const sender = escapeHtml(msg.name || (isUser ? 'User' : 'Character'));
            const preview = escapeHtml(toPlainPreview(msg.mes));
            const starred = isBookmarked(floorIndex);
            const note = starred ? escapeHtml(getBookmarkNote(floorIndex)) : '';

            const rowClasses = [
                'fj_item',
                isUser ? 'fj_is_user' : 'fj_is_bot',
                isHidden ? 'fj_is_hidden' : '',
                isSelected ? 'fj_is_selected' : '',
                isAnchor ? 'fj_is_range_anchor' : '',
            ].filter(Boolean).join(' ');

            html += `
                <div class="${rowClasses}" data-floor="${floorIndex}">
                    <div class="fj_item_top">
                        <div class="fj_item_meta">
                            ${state.batchMode ? `<span class="fj_select_box"><i class="${isSelected ? 'fa-solid fa-square-check' : 'fa-regular fa-square'}"></i></span>` : ''}
                            <span class="fj_floor_badge">#${floorIndex}</span>
                            <span class="fj_sender" title="${sender}">${sender}</span>
                            ${isHidden ? '<span class="fj_hidden_tag">已隐藏</span>' : ''}
                            ${note ? `<span class="fj_bookmark_note" title="${note}">· ${note}</span>` : ''}
                        </div>
                        <div class="fj_item_actions">
                            <button type="button" class="fj_icon_btn fj_hide_btn ${isHidden ? 'fj_hidden_state' : ''}" data-action="hide" data-floor="${floorIndex}" title="${isHidden ? '取消隐藏此楼' : '隐藏此楼'}">
                                <i class="${isHidden ? 'fa-solid fa-eye-slash' : 'fa-regular fa-eye'}"></i>
                            </button>
                            ${starred ? `<button type="button" class="fj_icon_btn fj_note_btn" data-action="note" data-floor="${floorIndex}" title="编辑书签备注"><i class="fa-solid fa-pen"></i></button>` : ''}
                            <button type="button" class="fj_icon_btn fj_star_btn ${starred ? 'fj_bookmarked' : ''}" data-action="star" data-floor="${floorIndex}" title="${starred ? '取消书签' : '添加书签'}">
                                <i class="${starred ? 'fa-solid' : 'fa-regular'} fa-star"></i>
                            </button>
                        </div>
                    </div>
                    <div class="fj_item_preview">${preview}</div>
                </div>
            `;
        }

        dom.items.innerHTML = html;
    }

    function scheduleRender() {
        if (state.rafId !== null) return;
        state.rafId = requestAnimationFrame(() => {
            state.rafId = null;
            renderVisibleRows();
        });
    }

    function updateFooterStatus(text) {
        if (dom.footerStatus) {
            dom.footerStatus.textContent = text;
        }
    }

    async function editBookmarkNote(floorIndex) {
        const currentNote = getBookmarkNote(floorIndex);
        const ctx = getContext();
        let nextNote = null;

        if (typeof ctx?.callGenericPopup === 'function' && ctx?.POPUP_TYPE) {
            const res = await ctx.callGenericPopup(
                `编辑 #${floorIndex} 楼书签备注（留空清除备注）：`,
                ctx.POPUP_TYPE.INPUT,
                currentNote,
            );
            if (res === null || res === false) return;
            nextNote = String(res);
        } else {
            const res = window.prompt(`编辑 #${floorIndex} 楼书签备注：`, currentNote);
            if (res === null) return;
            nextNote = res;
        }

        setBookmark(floorIndex, nextNote);
        rebuildFilteredList(false);
        updateFooterStatus(`已更新 #${floorIndex} 书签备注`);
    }

    /** 打开/关闭独立窗口 */
    function toggleWindow(forceState) {
        const nextOpen = typeof forceState === 'boolean' ? forceState : !state.isOpen;
        state.isOpen = nextOpen;

        if (!dom.win) return;
        dom.win.classList.toggle('fj_hidden', !nextOpen);

        if (nextOpen) {
            state.keptInHiddenTab.clear();
            clampWindowToViewport();
            rebuildFilteredList(false);
            updateFooterStatus('就绪');
        }
    }

    /** 拖拽独立窗口（桌面端） */
    function setupDragging(handleEl, winEl) {
        let dragging = false;
        let startX = 0;
        let startY = 0;
        let originLeft = 0;
        let originTop = 0;

        const onPointerMove = (e) => {
            if (!dragging) return;
            const nextLeft = Math.max(8, Math.min(window.innerWidth - 120, originLeft + (e.clientX - startX)));
            const nextTop = Math.max(8, Math.min(window.innerHeight - 60, originTop + (e.clientY - startY)));
            winEl.style.left = `${nextLeft}px`;
            winEl.style.top = `${nextTop}px`;
            winEl.style.right = 'auto';
        };

        const onPointerUp = () => {
            if (!dragging) return;
            dragging = false;
            document.removeEventListener('pointermove', onPointerMove);
            document.removeEventListener('pointerup', onPointerUp);
            try {
                localStorage.setItem(POS_STORAGE_KEY, JSON.stringify({
                    left: parseFloat(winEl.style.left),
                    top: parseFloat(winEl.style.top),
                }));
            } catch { /* ignore storage errors */ }
        };

        handleEl.addEventListener('pointerdown', (e) => {
            if (window.innerWidth <= 768) return;
            if (e.target instanceof Element && e.target.closest('button')) return;

            const rect = winEl.getBoundingClientRect();
            dragging = true;
            startX = e.clientX;
            startY = e.clientY;
            originLeft = rect.left;
            originTop = rect.top;

            document.addEventListener('pointermove', onPointerMove);
            document.addEventListener('pointerup', onPointerUp);
        });
    }

    function restoreWindowPosition() {
        if (!dom.win || window.innerWidth <= 768) return;
        try {
            const saved = JSON.parse(localStorage.getItem(POS_STORAGE_KEY) || 'null');
            if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
                dom.win.style.left = `${saved.left}px`;
                dom.win.style.top = `${saved.top}px`;
                dom.win.style.right = 'auto';
            }
        } catch { /* ignore */ }
    }

    function clampWindowToViewport() {
        if (!dom.win || window.innerWidth <= 768) return;
        const rect = dom.win.getBoundingClientRect();
        if (rect.width === 0) return;
        let changed = false;
        let left = rect.left;
        let top = rect.top;

        if (left > window.innerWidth - 80) {
            left = Math.max(12, window.innerWidth - rect.width - 16);
            changed = true;
        }
        if (top > window.innerHeight - 60) {
            top = Math.max(12, window.innerHeight - rect.height - 16);
            changed = true;
        }
        if (changed) {
            dom.win.style.left = `${left}px`;
            dom.win.style.top = `${top}px`;
            dom.win.style.right = 'auto';
        }
    }

    /** 构建独立悬浮窗口 DOM */
    function createWindow() {
        if (document.getElementById('fj_window')) return;

        const win = document.createElement('div');
        win.id = 'fj_window';
        win.className = 'fj_hidden';
        win.innerHTML = `
            <div class="fj_header" id="fj_drag_handle">
                <div class="fj_title_group">
                    <i class="fa-solid fa-layer-group"></i>
                    <span class="fj_title">楼层跳转</span>
                    <span class="fj_stats" id="fj_stats"></span>
                </div>
                <div class="fj_header_actions">
                    <button type="button" class="fj_icon_btn" id="fj_sort_btn" title="切换正序/倒序">
                        <i class="fa-solid fa-arrow-down-short-wide"></i>
                    </button>
                    <button type="button" class="fj_icon_btn" id="fj_refresh_btn" title="刷新目录">
                        <i class="fa-solid fa-rotate-right"></i>
                    </button>
                    <button type="button" class="fj_icon_btn" id="fj_close_btn" title="关闭 (ESC)">
                        <i class="fa-solid fa-xmark"></i>
                    </button>
                </div>
            </div>

            <div class="fj_toolbar">
                <div class="fj_jump_row">
                    <input type="number" id="fj_jump_input" class="fj_input fj_input_num" min="0" step="1" placeholder="楼层号" />
                    <button type="button" id="fj_jump_btn" class="fj_btn fj_btn_primary">跳转</button>
                    <div class="fj_quick_nav" style="margin-left:auto;">
                        <button type="button" class="fj_icon_btn" id="fj_top_btn" title="回到顶部 (#0)">
                            <i class="fa-solid fa-angles-up"></i>
                        </button>
                        <button type="button" class="fj_icon_btn" id="fj_bottom_btn" title="直达底部 (最新楼)">
                            <i class="fa-solid fa-angles-down"></i>
                        </button>
                        <button type="button" class="fj_icon_btn" id="fj_prev_user_btn" title="上一条用户消息">
                            <i class="fa-solid fa-angle-up"></i>
                        </button>
                        <button type="button" class="fj_icon_btn" id="fj_next_user_btn" title="下一条用户消息">
                            <i class="fa-solid fa-angle-down"></i>
                        </button>
                    </div>
                </div>

                <div class="fj_search_wrap">
                    <i class="fa-solid fa-magnifying-glass fj_search_icon"></i>
                    <input type="text" id="fj_search_input" class="fj_input" placeholder="搜索楼层号 / 角色名 / 内容 / 书签备注…" />
                    <button type="button" id="fj_search_clear" class="fj_icon_btn fj_search_clear" title="清空搜索" style="display:none;">
                        <i class="fa-solid fa-xmark"></i>
                    </button>
                </div>

                <div class="fj_filter_row">
                    <div class="fj_tabs" id="fj_tabs">
                        <button type="button" class="fj_tab fj_active" data-filter="all">全部</button>
                        <button type="button" class="fj_tab" data-filter="user">用户</button>
                        <button type="button" class="fj_tab" data-filter="bot">角色</button>
                        <button type="button" class="fj_tab" data-filter="bookmark">书签</button>
                        <button type="button" class="fj_tab" data-filter="hidden">已隐藏</button>
                    </div>
                    <div class="fj_filter_right">
                        <button type="button" class="fj_batch_toggle" id="fj_batch_toggle" title="批量多选隐藏或显示楼层">
                            <i class="fa-regular fa-square-check"></i>
                            <span>多选</span>
                        </button>
                        <label class="fj_auto_close_label" title="点击跳转后自动收起本窗口">
                            <input type="checkbox" id="fj_auto_close_cb" ${state.autoClose ? 'checked' : ''} />
                            <span>跳后收起</span>
                        </label>
                    </div>
                </div>

                <div class="fj_batch_bar fj_hidden" id="fj_batch_bar">
                    <div class="fj_batch_row">
                        <div class="fj_batch_group">
                            <button type="button" class="fj_batch_btn" id="fj_range_btn" title="开启后依次点击起止两楼自动连选中间所有楼层">
                                <i class="fa-solid fa-arrows-left-right-to-line"></i>
                                <span>连选</span>
                            </button>
                            <button type="button" class="fj_batch_btn" id="fj_batch_all_btn" title="全选当前筛选结果中的所有楼层">
                                <span>全选</span>
                            </button>
                            <button type="button" class="fj_batch_btn" id="fj_batch_clear_btn" title="清空已选楼层" disabled>
                                <span>清空</span>
                            </button>
                        </div>
                        <div class="fj_batch_group">
                            <button type="button" class="fj_batch_btn fj_batch_btn_accent" id="fj_batch_hide_btn" disabled>
                                <i class="fa-solid fa-eye-slash"></i>
                                <span>隐藏</span>
                            </button>
                            <button type="button" class="fj_batch_btn fj_batch_btn_accent" id="fj_batch_show_btn" disabled>
                                <i class="fa-regular fa-eye"></i>
                                <span>显示</span>
                            </button>
                        </div>
                    </div>
                    <div class="fj_batch_hint" id="fj_batch_hint">点击楼层勾选，桌面端支持 Shift 连选</div>
                </div>
            </div>

            <div class="fj_list_viewport" id="fj_list_viewport">
                <div class="fj_list_spacer" id="fj_list_spacer">
                    <div class="fj_list_items" id="fj_list_items"></div>
                </div>
            </div>

            <div class="fj_footer">
                <span id="fj_footer_count">匹配 0 / 0 楼</span>
                <span id="fj_footer_status">就绪</span>
            </div>
        `;

        document.body.appendChild(win);

        // 独立的轻提示/加载条，窗口收起后依然可见
        const notice = document.createElement('div');
        notice.id = 'fj_notice';
        notice.innerHTML = '<i class="fa-solid fa-check fj_notice_icon"></i><span class="fj_notice_text"></span>';
        document.body.appendChild(notice);

        dom.win = win;
        dom.notice = notice;
        dom.noticeIcon = notice.querySelector('.fj_notice_icon');
        dom.noticeText = notice.querySelector('.fj_notice_text');
        dom.dragHandle = win.querySelector('#fj_drag_handle');
        dom.stats = win.querySelector('#fj_stats');
        dom.sortBtn = win.querySelector('#fj_sort_btn');
        dom.refreshBtn = win.querySelector('#fj_refresh_btn');
        dom.closeBtn = win.querySelector('#fj_close_btn');
        dom.jumpInput = win.querySelector('#fj_jump_input');
        dom.jumpBtn = win.querySelector('#fj_jump_btn');
        dom.topBtn = win.querySelector('#fj_top_btn');
        dom.bottomBtn = win.querySelector('#fj_bottom_btn');
        dom.prevUserBtn = win.querySelector('#fj_prev_user_btn');
        dom.nextUserBtn = win.querySelector('#fj_next_user_btn');
        dom.searchInput = win.querySelector('#fj_search_input');
        dom.searchClear = win.querySelector('#fj_search_clear');
        dom.tabs = win.querySelector('#fj_tabs');
        dom.batchToggle = win.querySelector('#fj_batch_toggle');
        dom.batchBar = win.querySelector('#fj_batch_bar');
        dom.rangeBtn = win.querySelector('#fj_range_btn');
        dom.batchAllBtn = win.querySelector('#fj_batch_all_btn');
        dom.batchClearBtn = win.querySelector('#fj_batch_clear_btn');
        dom.batchHideBtn = win.querySelector('#fj_batch_hide_btn');
        dom.batchShowBtn = win.querySelector('#fj_batch_show_btn');
        dom.batchHint = win.querySelector('#fj_batch_hint');
        dom.autoCloseCb = win.querySelector('#fj_auto_close_cb');
        dom.viewport = win.querySelector('#fj_list_viewport');
        dom.spacer = win.querySelector('#fj_list_spacer');
        dom.items = win.querySelector('#fj_list_items');
        dom.footerCount = win.querySelector('#fj_footer_count');
        dom.footerStatus = win.querySelector('#fj_footer_status');

        restoreWindowPosition();
        setupDragging(dom.dragHandle, win);
        bindWindowEvents();
    }

    function bindWindowEvents() {
        dom.closeBtn.addEventListener('click', () => toggleWindow(false));
        dom.refreshBtn.addEventListener('click', () => {
            state.keptInHiddenTab.clear();
            rebuildFilteredList(false);
            updateFooterStatus('已刷新');
        });

        dom.sortBtn.addEventListener('click', () => {
            state.reverseOrder = !state.reverseOrder;
            const icon = dom.sortBtn.querySelector('i');
            if (icon) {
                icon.className = state.reverseOrder
                    ? 'fa-solid fa-arrow-up-wide-short'
                    : 'fa-solid fa-arrow-down-short-wide';
            }
            dom.sortBtn.title = state.reverseOrder ? '当前：倒序（点击切正序）' : '当前：正序（点击切倒序）';
            rebuildFilteredList(true);
        });

        // 输入楼层号跳转
        const triggerInputJump = () => {
            const val = dom.jumpInput.value.trim();
            if (val === '') return;
            jumpToFloor(Number(val));
        };
        dom.jumpBtn.addEventListener('click', triggerInputJump);
        dom.jumpInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                triggerInputJump();
            }
        });

        // 快捷按钮
        dom.topBtn.addEventListener('click', () => jumpToFloor(0));
        dom.bottomBtn.addEventListener('click', () => {
            const chat = getChat();
            if (chat.length) jumpToFloor(chat.length - 1);
        });
        dom.prevUserBtn.addEventListener('click', () => jumpAdjacentUserMessage(-1));
        dom.nextUserBtn.addEventListener('click', () => jumpAdjacentUserMessage(1));

        // 关键词搜索（防抖 180ms）
        dom.searchInput.addEventListener('input', () => {
            const val = dom.searchInput.value;
            dom.searchClear.style.display = val ? 'inline-flex' : 'none';
            clearTimeout(state.searchTimer);
            state.searchTimer = setTimeout(() => {
                state.query = val;
                rebuildFilteredList(true);
            }, 180);
        });

        dom.searchClear.addEventListener('click', () => {
            dom.searchInput.value = '';
            dom.searchClear.style.display = 'none';
            state.query = '';
            rebuildFilteredList(true);
            dom.searchInput.focus();
        });

        // 跳转后自动收起开关
        dom.autoCloseCb.addEventListener('change', () => {
            state.autoClose = dom.autoCloseCb.checked;
            try {
                localStorage.setItem(AUTO_CLOSE_STORAGE_KEY, state.autoClose ? '1' : '0');
            } catch { /* ignore */ }
        });

        // 多选模式开关与批量操作栏
        dom.batchToggle.addEventListener('click', () => {
            setBatchMode(!state.batchMode);
        });

        dom.rangeBtn.addEventListener('click', () => {
            state.rangeMode = !state.rangeMode;
            state.rangeAnchorFloor = null;
            updateBatchUI();
            renderVisibleRows();
        });

        dom.batchAllBtn.addEventListener('click', () => {
            for (let i = 0; i < state.filteredIndices.length; i++) {
                state.selectedFloors.add(state.filteredIndices[i]);
            }
            state.rangeAnchorFloor = null;
            updateBatchUI();
            renderVisibleRows();
        });

        dom.batchClearBtn.addEventListener('click', () => {
            state.selectedFloors.clear();
            state.rangeAnchorFloor = null;
            state.lastClickedFloor = null;
            updateBatchUI();
            renderVisibleRows();
        });

        dom.batchHideBtn.addEventListener('click', async () => {
            if (!state.selectedFloors.size) return;
            const targets = Array.from(state.selectedFloors);
            await setFloorsHidden(targets, true);
            state.selectedFloors.clear();
            state.rangeAnchorFloor = null;
            updateBatchUI();
            renderVisibleRows();
        });

        dom.batchShowBtn.addEventListener('click', async () => {
            if (!state.selectedFloors.size) return;
            const targets = Array.from(state.selectedFloors);
            await setFloorsHidden(targets, false);
            state.selectedFloors.clear();
            state.rangeAnchorFloor = null;
            updateBatchUI();
            renderVisibleRows();
        });

        // 筛选标签切换
        dom.tabs.addEventListener('click', (e) => {
            const btn = e.target instanceof Element ? e.target.closest('.fj_tab') : null;
            if (!btn) return;
            const nextFilter = btn.getAttribute('data-filter');
            if (!nextFilter || nextFilter === state.filter) return;

            state.filter = nextFilter;
            state.keptInHiddenTab.clear();
            dom.tabs.querySelectorAll('.fj_tab').forEach((el) => {
                el.classList.toggle('fj_active', el === btn);
            });
            rebuildFilteredList(true);
        });

        // 虚拟列表滚动
        dom.viewport.addEventListener('scroll', scheduleRender, { passive: true });

        // 列表项事件委托（点击跳转 / 多选连选 / 隐藏显示 / 收藏 / 编辑备注）
        dom.items.addEventListener('click', (e) => {
            const target = e.target instanceof Element ? e.target : null;
            if (!target) return;

            const actionBtn = target.closest('[data-action]');
            if (actionBtn) {
                e.stopPropagation();
                const action = actionBtn.getAttribute('data-action');
                const floor = Number(actionBtn.getAttribute('data-floor'));
                if (!Number.isInteger(floor)) return;

                if (action === 'hide') {
                    const msg = getChat()[floor];
                    if (msg) {
                        setFloorsHidden([floor], !Boolean(msg.is_system));
                    }
                } else if (action === 'star') {
                    if (isBookmarked(floor)) {
                        removeBookmark(floor);
                        updateFooterStatus(`已移除 #${floor} 书签`);
                    } else {
                        setBookmark(floor, '');
                        updateFooterStatus(`已收藏 #${floor}`);
                    }
                    rebuildFilteredList(false);
                } else if (action === 'note') {
                    editBookmarkNote(floor);
                }
                return;
            }

            const row = target.closest('.fj_item[data-floor]');
            if (!row) return;

            const floor = Number(row.getAttribute('data-floor'));
            if (!Number.isInteger(floor)) return;

            if (state.batchMode) {
                if (e.shiftKey && state.lastClickedFloor !== null) {
                    const added = selectRangeBetween(state.lastClickedFloor, floor);
                    state.lastClickedFloor = floor;
                    state.rangeAnchorFloor = null;
                    updateFooterStatus(`已连选 ${added} 个楼层`);
                } else if (state.rangeMode) {
                    if (state.rangeAnchorFloor === null) {
                        state.rangeAnchorFloor = floor;
                        state.selectedFloors.add(floor);
                        state.lastClickedFloor = floor;
                        updateFooterStatus(`已设连选起点 #${floor}，请点终点`);
                    } else {
                        const added = selectRangeBetween(state.rangeAnchorFloor, floor);
                        state.rangeAnchorFloor = null;
                        state.lastClickedFloor = floor;
                        updateFooterStatus(`已连选 ${added} 个楼层`);
                    }
                } else {
                    if (state.selectedFloors.has(floor)) {
                        state.selectedFloors.delete(floor);
                    } else {
                        state.selectedFloors.add(floor);
                    }
                    state.lastClickedFloor = floor;
                }
                updateBatchUI();
                renderVisibleRows();
                return;
            }

            jumpToFloor(floor);
        });

        // ESC 关闭窗口
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && state.isOpen) {
                toggleWindow(false);
            }
        });
    }

    /** 挂载魔术棒菜单入口 */
    function mountWandMenuButton() {
        if (document.getElementById('fj_wand_btn')) return true;
        const menu = document.getElementById('extensionsMenu');
        if (!menu) return false;

        const btn = document.createElement('div');
        btn.id = 'fj_wand_btn';
        btn.className = 'list-group-item flex-container flexGap5 interactable';
        btn.tabIndex = 0;
        btn.innerHTML = `
            <div class="fa-solid fa-layer-group extensionsMenuExtensionButton"></div>
            <span>楼层跳转</span>
        `;
        btn.addEventListener('click', () => {
            toggleWindow();
        });
        menu.appendChild(btn);
        return true;
    }

    /** 绑定酒馆事件（仅在窗口打开时刷新，平时零开销） */
    function bindSillyTavernEvents() {
        const ctx = getContext();
        const es = ctx?.eventSource;
        const et = ctx?.eventTypes;
        if (!es || !et) return;

        const onChatUpdate = () => {
            if (state.isOpen) rebuildFilteredList(false);
        };
        const onChatChanged = () => {
            state.lastJumpedIndex = null;
            state.selectedFloors.clear();
            state.keptInHiddenTab.clear();
            state.rangeAnchorFloor = null;
            state.lastClickedFloor = null;
            if (state.isOpen) rebuildFilteredList(true);
        };

        const updateEvents = [
            et.MESSAGE_SENT,
            et.MESSAGE_RECEIVED,
            et.MESSAGE_DELETED,
            et.MESSAGE_EDITED,
            et.MESSAGE_SWIPED,
        ].filter(Boolean);

        if (et.CHAT_CHANGED) {
            es.on(et.CHAT_CHANGED, onChatChanged);
        }
        updateEvents.forEach((evt) => es.on(evt, onChatUpdate));
    }

    function init() {
        createWindow();
        bindSillyTavernEvents();

        if (!mountWandMenuButton()) {
            // 若魔术棒菜单尚未挂载，短轮询兜底
            let retries = 0;
            const timer = setInterval(() => {
                retries++;
                if (mountWandMenuButton() || retries >= 20) {
                    clearInterval(timer);
                }
            }, 300);
        }

        console.debug(`[${EXT_ID}] initialized`);
    }

    if (typeof window.jQuery === 'function') {
        window.jQuery(init);
    } else if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
