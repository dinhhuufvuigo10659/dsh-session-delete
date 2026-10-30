/**
 * Client half of @local/dsh-session-delete.
 *
 * Right-clicking a Session row in the sidebar opens this plugin's own context
 * menu on the frame-wide overlay layer. Choosing "Delete session" asks for an
 * explicit confirmation, then posts to the plugin's loopback Host route, which
 * detaches and removes the Session's durable log. The same action is also a row
 * in the Session's "..." menu, so the capability stays reachable for keyboard
 * and touch users.
 *
 * The sidebar row is `div[role="treeitem"][data-row-key="session:<id>"]`; that
 * attribute is the only identity the shipped row exposes, and it doubles as the
 * list's animation key.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-session-delete',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'dsh-session-delete'
    /**
     * Document-relative on purpose: the served index carries `<base href="./">`,
     * so this resolves under a mounted deployment too, exactly like the shipped
     * plugin routes (`"/open-in-app/apps".slice(1)`).
     */
    const DELETE_ENDPOINT = 'dsh-session-delete/delete'
    const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/
    const ROW_KEY_ATTRIBUTE = 'data-row-key'
    const SESSION_ROW_PREFIX = 'session:'

    const EN = {
      openMenu: 'Session actions',
      menuDelete: 'Delete session…',
      confirmTitle: 'Delete permanently?',
      confirmBody: 'The saved log of “{title}” is removed from disk. This cannot be undone.',
      confirmDelete: 'Delete',
      cancel: 'Cancel',
      back: 'Back',
      deleting: 'Deleting…',
      done: 'Session deleted',
      nothingToDelete: 'This session has no saved log yet, so there is nothing to delete.',
      unnamed: 'Untitled session',
      openGuard: 'This is the open session. Switch to another one first, then delete it.',
      errNotFound: 'This session no longer exists.',
      errForbidden: 'The request was refused: it must come from this machine and this page.',
      errAuth: 'This page is no longer authenticated. Reopen the address printed by dsh web, then try again.',
      errInvalid: 'That session id is not valid.',
      errUnverified: 'Refused: no verified transcript directory was found for this session.',
      errRemoveFailed: 'The transcript directory could not be removed: {message}',
      errGeneric: 'Could not delete the session: {message}',
    }

    const ZH = {
      openMenu: '会话操作',
      menuDelete: '删除会话…',
      confirmTitle: '永久删除？',
      confirmBody: '「{title}」保存的会话日志会从磁盘上删除，无法恢复。',
      confirmDelete: '删除',
      cancel: '取消',
      back: '返回',
      deleting: '正在删除…',
      done: '会话已删除',
      nothingToDelete: '该会话还没有保存到磁盘，无需删除。',
      unnamed: '未命名会话',
      openGuard: '这是当前打开的会话。请先切换到其他会话，再删除它。',
      errNotFound: '该会话已不存在。',
      errForbidden: '请求被拒绝：只接受来自本机、本页面的请求。',
      errAuth: '页面鉴权已失效。请用 dsh web 打印的地址重新打开页面，再试一次。',
      errInvalid: '会话 ID 不合法。',
      errUnverified: '已拒绝：找不到可验证的会话日志目录。',
      errRemoveFailed: '会话日志目录删除失败：{message}',
      errGeneric: '删除失败：{message}',
    }

    function dictFor(id) {
      return /^zh/i.test(String(id || '')) ? ZH : EN
    }

    function translate(dict, key, vars) {
      const template = dict[key] || EN[key] || key
      if (!vars) return template
      return template.replace(/\{(\w+)\}/g, (match, name) =>
        Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match,
      )
    }

    let localeFace = null

    function activeDict() {
      let id = ''
      try {
        const snapshot =
          localeFace && typeof localeFace.getSnapshot === 'function' ? localeFace.getSnapshot() : null
        id = String((snapshot && snapshot.active) || '')
      } catch {
        id = ''
      }
      return dictFor(id)
    }

    /** Visible text follows the Client locale service, including live switches. */
    function useDict() {
      const [dict, setDict] = React.useState(activeDict)
      React.useEffect(() => {
        if (!localeFace || typeof localeFace.subscribe !== 'function') return undefined
        setDict(activeDict())
        return localeFace.subscribe(() => setDict(activeDict()))
      }, [])
      return dict
    }

    // ------------------------------------------------------------------
    // Context-menu state: one module-level store, read by the overlay entry.
    // ------------------------------------------------------------------
    let menuState = null
    const listeners = new Set()

    function emit(next) {
      menuState = next
      for (const listener of listeners) listener()
    }

    const store = {
      get: () => menuState,
      subscribe(listener) {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
      close: () => emit(null),
    }

    function displayTitleOf(value) {
      const text = String(value || '').replace(/\s+/g, ' ').trim()
      return text.length > 80 ? `${text.slice(0, 79)}…` : text
    }

    function rowForSession(sessionId) {
      if (!SESSION_ID_PATTERN.test(sessionId)) return null
      try {
        return document.querySelector(`[${ROW_KEY_ATTRIBUTE}="${SESSION_ROW_PREFIX}${sessionId}"]`)
      } catch {
        return null
      }
    }

    function isOpenSession(sessionId) {
      const row = rowForSession(sessionId)
      return row !== null && row.getAttribute('aria-selected') === 'true'
    }

    /** Resolve the Session a right-click landed on. */
    function sessionRowFor(target) {
      if (!target || typeof target.closest !== 'function') return null
      const row = target.closest(`[${ROW_KEY_ATTRIBUTE}]`)
      if (!row) return null
      const key = row.getAttribute(ROW_KEY_ATTRIBUTE) || ''
      if (!key.startsWith(SESSION_ROW_PREFIX)) return null
      const sessionId = key.slice(SESSION_ROW_PREFIX.length)
      if (!SESSION_ID_PATTERN.test(sessionId)) return null
      return { sessionId, row }
    }

    /**
     * The row's visible title. The shipped row keeps it in the span whose
     * class name ends in `_title`; anything else falls back to the row text.
     */
    function sessionTitleOf(row) {
      try {
        const spans = Array.from(row.querySelectorAll('span'))
        const titled = spans.find((node) => typeof node.className === 'string' && /(^|\s)[^\s]*_title(\s|$)/.test(node.className))
        const text = (titled && titled.textContent) || row.textContent || ''
        return text
      } catch {
        return ''
      }
    }

    function openMenu(sessionId, title, anchor) {
      if (!SESSION_ID_PATTERN.test(sessionId)) return
      emit({
        phase: 'menu',
        sessionId,
        title: displayTitleOf(title),
        selected: isOpenSession(sessionId),
        x: anchor && typeof anchor.x === 'number' ? anchor.x : null,
        y: anchor && typeof anchor.y === 'number' ? anchor.y : null,
      })
    }

    function failureMessage(dict, body) {
      const code = body && body.code
      if (code === 'unauthenticated') return dict.errAuth
      if (code === 'session-not-found') return dict.errNotFound
      if (code === 'forbidden') return dict.errForbidden
      if (code === 'invalid-id') return dict.errInvalid
      if (code === 'path-unverified') return dict.errUnverified
      if (code === 'remove-failed') return translate(dict, 'errRemoveFailed', { message: (body && body.message) || code })
      const detail = body && typeof body.message === 'string' && body.message ? body.message : code || 'unknown'
      return translate(dict, 'errGeneric', { message: detail })
    }

    /**
     * Same-origin, so the deployment's session cookie rides along by default;
     * the Host route re-checks it through `connection.requestRejection`.
     */
    async function requestDelete(sessionId) {
      const response = await fetch(DELETE_ENDPOINT, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      })
      let body = null
      try {
        body = await response.json()
      } catch {
        body = null
      }
      if (response.ok && body && body.ok === true) return { ok: true, body }
      if (response.status === 401) return { ok: false, body: { code: 'unauthenticated' } }
      return { ok: false, body: body || { code: `http-${response.status}` } }
    }

    /**
     * The Host detaches the Session and emits `api-session/removed`, so the row
     * normally disappears on its own. Reload only when it does not.
     */
    async function settleAfterDelete(sessionId) {
      for (let tick = 0; tick < 12; tick += 1) {
        if (rowForSession(sessionId) === null) return true
        await new Promise((resolve) => setTimeout(resolve, 120))
      }
      return false
    }

    // ------------------------------------------------------------------
    // Presentation
    // ------------------------------------------------------------------
    const CARD = {
      position: 'fixed',
      zIndex: 2147483000,
      minWidth: '248px',
      maxWidth: '340px',
      padding: '6px',
      borderRadius: '12px',
      border: '1px solid var(--dsw-alias-border-l1)',
      background: 'var(--dsw-alias-bg-overlay)',
      boxShadow: '0 12px 32px rgba(0, 0, 0, 0.28), 0 2px 6px rgba(0, 0, 0, 0.16)',
      color: 'var(--dsw-alias-label-primary)',
      font: '13px/1.45 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif',
      pointerEvents: 'auto',
    }

    function MenuButton(props) {
      const [hover, setHover] = React.useState(false)
      const danger = props.danger === true
      const disabled = props.disabled === true
      const color = disabled
        ? 'var(--dsw-alias-label-secondary)'
        : danger
          ? 'var(--dsw-alias-state-error-primary)'
          : 'var(--dsw-alias-label-primary)'
      return h(
        'button',
        {
          type: 'button',
          role: 'menuitem',
          disabled,
          title: props.title,
          onClick: props.onClick,
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            width: '100%',
            padding: '0 10px',
            minHeight: '32px',
            border: 0,
            borderRadius: '8px',
            background: !disabled && hover ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
            color,
            font: 'inherit',
            textAlign: 'left',
            cursor: disabled ? 'default' : 'pointer',
          },
        },
        props.children || props.label,
      )
    }

    function Hint(props) {
      return h(
        'div',
        {
          style: {
            padding: '2px 10px 8px',
            color: 'var(--dsw-alias-label-secondary)',
            fontSize: '12px',
            lineHeight: 1.5,
          },
        },
        props.children,
      )
    }

    function OverlayEntry() {
      const dict = useDict()
      const menu = React.useSyncExternalStore(store.subscribe, store.get, store.get)
      const [error, setError] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const cardRef = React.useRef(null)
      const phaseKey = menu ? `${menu.phase}:${menu.sessionId}` : ''

      React.useEffect(() => {
        setError(null)
        setBusy(false)
        if (!menu) return
        const card = cardRef.current
        if (card && typeof card.focus === 'function') {
          try {
            card.focus({ preventScroll: true })
          } catch {
            card.focus()
          }
        }
      }, [phaseKey])

      React.useEffect(() => {
        if (!menu) return undefined
        if (menu.phase === 'done') {
          const timer = setTimeout(() => {
            if (store.get() && store.get().phase === 'done') store.close()
          }, 1400)
          return () => clearTimeout(timer)
        }
        const onKey = (event) => {
          if (event.key !== 'Escape') return
          event.preventDefault()
          event.stopPropagation()
          store.close()
        }
        const onPointer = (event) => {
          if (cardRef.current && cardRef.current.contains(event.target)) return
          store.close()
        }
        const onViewport = () => store.close()
        document.addEventListener('keydown', onKey, true)
        document.addEventListener('pointerdown', onPointer, true)
        window.addEventListener('blur', onViewport)
        window.addEventListener('resize', onViewport)
        return () => {
          document.removeEventListener('keydown', onKey, true)
          document.removeEventListener('pointerdown', onPointer, true)
          window.removeEventListener('blur', onViewport)
          window.removeEventListener('resize', onViewport)
        }
      }, [menu])

      if (!menu) return null

      const viewportWidth = window.innerWidth
      const viewportHeight = window.innerHeight
      const cardWidth = 340
      const cardHeight = menu.phase === 'confirm' ? 190 : 120
      const anchorX = typeof menu.x === 'number' ? menu.x : viewportWidth / 2 - cardWidth / 2
      const anchorY = typeof menu.y === 'number' ? menu.y : viewportHeight / 2 - cardHeight / 2
      const left = Math.max(8, Math.min(anchorX, viewportWidth - cardWidth - 8))
      const top = Math.max(8, Math.min(anchorY, viewportHeight - cardHeight - 8))
      const title = menu.title || dict.unnamed

      const card = (role, label, children, extra) =>
        h(
          'div',
          Object.assign(
            {
              ref: cardRef,
              role,
              'aria-label': label,
              tabIndex: -1,
              style: Object.assign({}, CARD, { left: `${left}px`, top: `${top}px`, outline: 'none' }),
              onContextMenu: (event) => event.preventDefault(),
            },
            extra || {},
          ),
          h(
            'div',
            {
              style: {
                padding: '6px 10px 8px',
                color: 'var(--dsw-alias-label-secondary)',
                fontSize: '12px',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              },
              title,
            },
            title,
          ),
          children,
        )

      if (menu.phase === 'done') {
        return card('status', dict.done, h(Hint, null, menu.message || dict.done))
      }

      if (menu.phase === 'confirm') {
        const confirm = async () => {
          setBusy(true)
          setError(null)
          try {
            const result = await requestDelete(menu.sessionId)
            if (result.ok) {
              setBusy(false)
              const removed =
                result.body && typeof result.body.removed === 'number' ? result.body.removed : 1
              if (removed === 0) {
                emit(Object.assign({}, menu, { phase: 'done', message: dict.nothingToDelete }))
                return
              }
              const settled = await settleAfterDelete(menu.sessionId)
              if (!settled) {
                window.location.reload()
                return
              }
              emit(Object.assign({}, menu, { phase: 'done', message: dict.done }))
              return
            }
            setBusy(false)
            setError(failureMessage(dict, result.body))
          } catch (exception) {
            setBusy(false)
            setError(translate(dict, 'errGeneric', { message: String((exception && exception.message) || exception) }))
          }
        }

        return card(
          'dialog',
          dict.confirmTitle,
          [
            h(
              'div',
              { key: 'body', style: { padding: '0 10px 10px' } },
              h('div', { style: { fontWeight: 600, marginBottom: '6px' } }, dict.confirmTitle),
              h(
                'div',
                { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px' } },
                translate(dict, 'confirmBody', { title }),
              ),
              error
                ? h(
                    'div',
                    {
                      role: 'alert',
                      style: { marginTop: '8px', color: 'var(--dsw-alias-state-error-primary)', fontSize: '12px' },
                    },
                    error,
                  )
                : null,
            ),
            h(
              'div',
              {
                key: 'actions',
                style: { display: 'flex', justifyContent: 'flex-end', gap: '6px', padding: '0 6px 2px' },
              },
              h(MenuButton, {
                label: error ? dict.back : dict.cancel,
                disabled: busy,
                onClick: () => (error ? emit(Object.assign({}, menu, { phase: 'menu' })) : store.close()),
              }),
              h(MenuButton, {
                label: busy ? dict.deleting : dict.confirmDelete,
                danger: true,
                disabled: busy,
                onClick: confirm,
              }),
            ),
          ],
        )
      }

      return card(
        'menu',
        dict.openMenu,
        [
          menu.selected
            ? h(Hint, { key: 'guard' }, dict.openGuard)
            : null,
          h(MenuButton, {
            key: 'delete',
            label: dict.menuDelete,
            danger: true,
            disabled: menu.selected === true,
            onClick: () => emit(Object.assign({}, menu, { phase: 'confirm' })),
          }),
        ],
      )
    }

    /** Dismiss a shipped menu surface through whichever shape it exposes. */
    function dismissMenuState(state) {
      try {
        if (!state) return
        if (Array.isArray(state)) {
          if (typeof state[1] === 'function') state[1](false)
          return
        }
        if (typeof state.close === 'function') state.close()
        else if (typeof state.setOpen === 'function') state.setOpen(false)
        else if (typeof state.hide === 'function') state.hide()
      } catch {
        // Dismissal is best effort; the overlay still opens.
      }
    }

    function SessionMenuRow(props) {
      const dict = useDict()
      const selected = isOpenSession(String(props.sessionId || ''))
      return h(MenuButton, {
        label: dict.menuDelete,
        danger: true,
        disabled: selected,
        title: selected ? dict.openGuard : undefined,
        onClick: () => {
          dismissMenuState(props.useMenuOpenState ? props.useMenuOpenState() : null)
          openMenu(String(props.sessionId || ''), props.displayTitle, null)
        },
      })
    }

    function apply(ctx) {
      localeFace = ctx.get('locale')

      ctx.effect(() => {
        const disposers = []
        for (const id of ['en-US', 'en', 'zh-CN', 'zh', 'zh-Hans']) {
          try {
            disposers.push(ctx.locale.register(NS, id, /^zh/i.test(id) ? ZH : EN))
          } catch {
            // A tag this build rejects; the remaining tags still apply.
          }
        }
        return () => {
          for (const dispose of disposers) {
            try {
              dispose()
            } catch {
              // Already removed.
            }
          }
        }
      }, 'session-delete locale')

      // The overlay entry owns the menu card and the confirmation step.
      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register({ name: 'shell.overlay', id: 'dsh-session-delete.menu', order: 400 }, OverlayEntry),
      )

      // The "..." row mirrors the same action for keyboard and touch users.
      ctx.slots.inject('sidebar.workspaces.session.menu.item', () =>
        ctx.slots.register(
          { name: 'sidebar.workspaces.session.menu.item', id: 'dsh-session-delete.delete', order: 470 },
          SessionMenuRow,
        ),
      )

      // Right-click on a Session row opens the same menu at the pointer.
      ctx.effect(() => {
        const onContextMenu = (event) => {
          if (event.defaultPrevented) return
          const hit = sessionRowFor(event.target)
          if (!hit) return
          event.preventDefault()
          event.stopPropagation()
          openMenu(hit.sessionId, sessionTitleOf(hit.row), { x: event.clientX, y: event.clientY })
        }
        document.addEventListener('contextmenu', onContextMenu, true)
        return () => document.removeEventListener('contextmenu', onContextMenu, true)
      }, 'session-delete right click')

      ctx.effect(() => () => store.close(), 'session-delete menu state')
    }

    return { inject: ['slots', 'locale'], apply }
  },
})
