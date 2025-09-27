const pinnedArea = document.querySelector('.pinned-area');
const pinnedContainer = document.getElementById('pinned-tabs');
const collectionsContainer = document.getElementById('tab-collections');
const tabTemplate = document.getElementById('tab-item-template');
const groupTemplate = document.getElementById('group-template');

const GROUP_COLORS = {
  grey: '#8a919f',
  blue: '#4c8dff',
  red: '#ff5d5d',
  yellow: '#ffd95d',
  green: '#4bd37b',
  pink: '#ff7ad9',
  purple: '#b678ff',
  cyan: '#4cd3ff',
  orange: '#ff9c5d'
};

const state = {
  windowId: null,
  collapsedGroups: new Set(),
  currentGroups: new Map(),
  draggedTabId: null,
  draggedGroupId: null,
  currentTabs: [],
  customTitles: new Map(),
  editingTabId: null
};

const tabCache = new Map();
const GROUP_COLOR_KEYS = Object.keys(GROUP_COLORS);
let groupColorIndex = 0;
let contextMenuEl = null;
const DRAG_MIME = 'application/x-side-tab-id';
let currentDropTargetSection = null;
let currentDropTargetItem = null;
let currentDropPosition = null;
let currentDropContext = null;
let pinnedDropActive = false;

let refreshTimer = null;

function chromeAsync(target, method, ...args) {
  return new Promise((resolve, reject) => {
    try {
      target[method](...args, (result) => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
        } else {
          resolve(result);
        }
      });
    } catch (error) {
      reject(error);
    }
  });
}

async function ensureWindowId() {
  if (typeof state.windowId === 'number') {
    return state.windowId;
  }

  try {
    const [activeTab] = await chromeAsync(chrome.tabs, 'query', {
      active: true,
      currentWindow: true
    });
    if (activeTab && typeof activeTab.windowId === 'number') {
      state.windowId = activeTab.windowId;
      return state.windowId;
    }
  } catch (error) {
    console.warn('Unable to determine window via active tab:', error);
  }

  try {
    const currentWindow = await chromeAsync(chrome.windows, 'getCurrent', { populate: false });
    if (currentWindow && typeof currentWindow.id === 'number') {
      state.windowId = currentWindow.id;
      return state.windowId;
    }
  } catch (error) {
    console.warn('Unable to determine window via getCurrent:', error);
  }

  return null;
}

async function fetchTabsAndGroups() {
  const windowId = await ensureWindowId();
  if (typeof windowId !== 'number') {
    return { tabs: [], groups: new Map() };
  }

  let tabs = [];
  try {
    tabs = await chromeAsync(chrome.tabs, 'query', { windowId });
  } catch (error) {
    console.error('Failed to query tabs:', error);
    return { tabs: [], groups: new Map() };
  }

  tabs.sort((a, b) => a.index - b.index);

  const groupIds = [...new Set(tabs.filter((tab) => tab.groupId !== -1).map((tab) => tab.groupId))];
  const groups = new Map();

  await Promise.all(
    groupIds.map(async (groupId) => {
      try {
        const group = await chromeAsync(chrome.tabGroups, 'get', groupId);
        groups.set(groupId, group);
      } catch (error) {
        console.warn(`Unable to fetch group ${groupId}:`, error);
      }
    })
  );

  return { tabs, groups };
}

function scheduleRefresh() {
  if (refreshTimer) {
    return;
  }
  refreshTimer = requestAnimationFrame(async () => {
    refreshTimer = null;
    const data = await fetchTabsAndGroups();
    render(data);
  });
}

function render({ tabs, groups }) {
  closeContextMenu();
  clearDropIndicators();
  tabCache.clear();
  for (const tab of tabs) {
    tabCache.set(tab.id, tab);
  }
  state.currentGroups = new Map(groups);
  state.currentTabs = tabs.slice();

  renderPinned(tabs);
  renderCollections(tabs, groups);
}

function renderPinned(tabs) {
  pinnedContainer.textContent = '';
  const pinnedTabs = tabs.filter((tab) => tab.pinned);

  pinnedContainer.classList.toggle('is-empty', !pinnedTabs.length);

  if (!pinnedTabs.length) {
    return;
  }

  const fragment = document.createDocumentFragment();

  for (const tab of pinnedTabs) {
    const button = document.createElement('button');
    button.className = 'pinned-tab';
    button.type = 'button';
    button.setAttribute('role', 'listitem');
    button.dataset.tabId = String(tab.id);
    button.draggable = true;
    const displayTitle = getDisplayTitle(tab);
    button.title = displayTitle;
    button.setAttribute('aria-label', displayTitle);
    if (tab.active) {
      button.classList.add('active');
    }

    const icon = createFaviconElement(tab, true);
    button.appendChild(icon);
    fragment.appendChild(button);
  }

  pinnedContainer.appendChild(fragment);
}

function renderCollections(tabs, groups) {
  collectionsContainer.textContent = '';

  const unpinned = tabs.filter((tab) => !tab.pinned);
  if (!unpinned.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No tabs open in this window.';
    collectionsContainer.appendChild(empty);
    return;
  }

  const groupEntryMap = new Map();
  const entries = [];

  for (const tab of unpinned) {
    if (tab.groupId !== -1) {
      let entry = groupEntryMap.get(tab.groupId);
      if (!entry) {
        const group = groups.get(tab.groupId) || { title: 'Group', color: 'grey' };
        entry = { type: 'group', id: tab.groupId, group, tabs: [] };
        groupEntryMap.set(tab.groupId, entry);
        entries.push(entry);
      }
      entry.tabs.push(tab);
    } else {
      entries.push({ type: 'tab', tab });
    }
  }

  const fragment = document.createDocumentFragment();

  for (const entry of entries) {
    if (entry.type === 'tab') {
      fragment.appendChild(buildTabItem(entry.tab));
    } else if (entry.type === 'group') {
      fragment.appendChild(buildGroupSection(entry));
    }
  }

  collectionsContainer.appendChild(fragment);
}

function buildTabItem(tab) {
  const clone = tabTemplate.content.firstElementChild.cloneNode(true);
  clone.dataset.tabId = String(tab.id);
  const isEditing = state.editingTabId === tab.id;
  if (isEditing) {
    clone.classList.add('is-renaming');
  }
  if (tab.active) {
    clone.classList.add('active');
  }
  if (tab.pinned) {
    clone.classList.add('is-pinned');
  }

  clone.draggable = !tab.pinned && !isEditing;

  const mainButton = clone.querySelector('.tab-main');
  mainButton.dataset.tabId = String(tab.id);
  mainButton.classList.toggle('is-editing', isEditing);
  if (isEditing) {
    mainButton.setAttribute('role', 'presentation');
    mainButton.removeAttribute('tabindex');
  } else {
    mainButton.setAttribute('role', 'button');
    mainButton.tabIndex = 0;
  }
  const displayTitle = getDisplayTitle(tab);
  mainButton.title = displayTitle;
  mainButton.setAttribute('aria-label', displayTitle);

  const faviconHolder = mainButton.querySelector('.tab-favicon');
  faviconHolder.textContent = '';
  faviconHolder.appendChild(createFaviconElement(tab));

  const titleEl = mainButton.querySelector('.tab-title');
  titleEl.textContent = displayTitle;

  const closeButton = clone.querySelector('.tab-close');
  if (closeButton) {
    closeButton.dataset.tabId = String(tab.id);
    closeButton.title = 'Close tab';
  }


  if (isEditing) {
    mainButton.setAttribute('aria-label', 'Editing tab title');
    const input = document.createElement('input');
    input.className = 'tab-rename-input';
    input.type = 'text';
    input.value = displayTitle;
    input.setAttribute('aria-label', 'Tab title');
    input.maxLength = 120;
    input.dataset.tabId = String(tab.id);
    input.addEventListener('keydown', handleRenameKeydown);
    input.addEventListener('blur', handleRenameCommit);

    const textContainer = mainButton.querySelector('.tab-text');
    textContainer.replaceChildren(input);

    requestAnimationFrame(() => {
      input.focus({ preventScroll: true });
      input.select();
    });
  }


  return clone;
}

function buildGroupSection(entry) {
  const { id, group, tabs } = entry;
  const clone = groupTemplate.content.firstElementChild.cloneNode(true);
  clone.dataset.groupId = String(id);

  const header = clone.querySelector('.group-header');
  const collapsed = state.collapsedGroups.has(id);
  header.dataset.collapsed = collapsed ? 'true' : 'false';
  header.draggable = true;
  header.dataset.groupId = String(id);

  const folderIcon = clone.querySelector('.group-folder-icon');
  if (folderIcon) {
    folderIcon.src = collapsed ? 'assets/group-closed.svg' : 'assets/group-open.svg';
  }

  const colorEl = clone.querySelector('.group-color');
  const mapped = GROUP_COLORS[group.color] || GROUP_COLORS.grey;
  colorEl.style.background = mapped;
  colorEl.style.boxShadow = `0 0 12px ${mapped}55`;

  const titleEl = clone.querySelector('.group-title');
  titleEl.textContent = group.title || 'Group';

  const countEl = clone.querySelector('.group-count');
  countEl.textContent = `${tabs.length} ${tabs.length === 1 ? 'tab' : 'tabs'}`;

  const body = clone.querySelector('.group-body');
  if (collapsed) {
    body.hidden = true;
  } else {
    const fragment = document.createDocumentFragment();
    for (const tab of tabs) {
      fragment.appendChild(buildTabItem(tab));
    }
    body.appendChild(fragment);
  }

  return clone;
}

function createFaviconElement(tab, isPinned = false) {
  const faviconUrl = tab.favIconUrl;
  if (faviconUrl && !faviconUrl.startsWith('chrome://favicon/')) {
    const img = document.createElement('img');
    img.src = faviconUrl;
    img.alt = '';
    img.decoding = 'async';
    if (isPinned) {
      img.loading = 'lazy';
    }
    return img;
  }

  const span = document.createElement('span');
  span.className = 'favicon-initial';
  span.textContent = getTabInitial(tab);
  return span;
}

function getTabInitial(tab) {
  try {
    const url = new URL(tab.url);
    if (url.hostname) {
      return url.hostname[0].toUpperCase();
    }
  } catch (error) {
    // ignore, fallback
  }

  if (tab.title) {
    const firstLetter = tab.title.trim()[0];
    if (firstLetter) {
      return firstLetter.toUpperCase();
    }
  }

  return '•';
}

function formatUrl(rawUrl) {
  if (!rawUrl) {
    return '';
  }
  try {
    const url = new URL(rawUrl);
    if (url.protocol === 'chrome:' || url.protocol === 'chrome-extension:' || url.protocol === 'edge:') {
      return url.pathname.replace(/\//g, ' ').trim();
    }
    if (url.hostname) {
      return url.hostname.replace(/^www\./, '');
    }
  } catch (error) {
    // ignore parsing failures and fall through
  }
  return rawUrl;
}

function getDisplayTitle(tab) {
  if (!tab) {
    return 'Untitled';
  }
  const alias = state.customTitles.get(tab.id);
  if (alias && alias.trim()) {
    return alias.trim();
  }
  return tab.title?.trim() || 'Untitled';
}

function getDraggedTab() {
  if (typeof state.draggedTabId !== 'number') {
    return null;
  }
  return tabCache.get(state.draggedTabId) || null;
}

function getDraggedGroup() {
  if (typeof state.draggedGroupId !== 'number') {
    return null;
  }
  return state.currentGroups.get(state.draggedGroupId) || null;
}

function clampIndexForGroup(groupId, index) {
  if (!Array.isArray(state.currentTabs) || !state.currentTabs.length) {
    return index;
  }

  if (groupId === -1) {
    const maxIndex = state.currentTabs.length;
    return Math.min(Math.max(index, 0), maxIndex);
  }

  const groupTabs = state.currentTabs
    .filter((tab) => tab.groupId === groupId)
    .sort((a, b) => a.index - b.index);

  if (!groupTabs.length) {
    return index;
  }

  const firstIndex = groupTabs[0].index;
  const lastIndex = groupTabs[groupTabs.length - 1].index;
  return Math.min(Math.max(index, firstIndex), lastIndex + 1);
}

function getGroupRange(groupId) {
  if (typeof groupId !== 'number') {
    return null;
  }
  const tabs = (state.currentTabs || [])
    .filter((tab) => tab.groupId === groupId)
    .sort((a, b) => a.index - b.index);

  if (!tabs.length) {
    return null;
  }

  const firstIndex = tabs[0].index;
  const lastIndex = tabs[tabs.length - 1].index;
  return {
    firstIndex,
    lastIndex,
    size: tabs.length
  };
}

function getDropContext(draggedTab, targetTab) {
  if (!draggedTab || !targetTab) {
    return null;
  }
  if (draggedTab.id === targetTab.id) {
    return null;
  }
  if (draggedTab.windowId !== targetTab.windowId) {
    return null;
  }

  if (draggedTab.pinned) {
    if (!targetTab.pinned) {
      return { type: 'unpin', groupId: targetTab.groupId };
    }
    return null;
  }

  if (targetTab.pinned) {
    return null;
  }

  if (draggedTab.groupId === targetTab.groupId) {
    return { type: 'reorder', groupId: targetTab.groupId };
  }

  return null;
}

function determineDropPosition(event, element) {
  const rect = element.getBoundingClientRect();
  const midpoint = rect.top + rect.height / 2;
  return event.clientY >= midpoint ? 'after' : 'before';
}

function handleGroupDragOverTab(event, tabItem) {
  const draggedGroupId = state.draggedGroupId;
  if (typeof draggedGroupId !== 'number') {
    return false;
  }

  const tabId = Number(tabItem.dataset.tabId);
  if (Number.isNaN(tabId)) {
    if (currentDropTargetItem === tabItem) {
      clearItemDropTarget();
    }
    return false;
  }

  const targetTab = tabCache.get(tabId);
  if (!targetTab || targetTab.groupId === draggedGroupId) {
    if (currentDropTargetItem === tabItem) {
      clearItemDropTarget();
    }
    return false;
  }

  if (!getGroupRange(draggedGroupId)) {
    return false;
  }

  const position = determineDropPosition(event, tabItem);
  setItemDropTarget(tabItem, position, {
    type: 'group-reorder',
    targetType: 'tab',
    targetId: tabId
  });
  clearGroupDropTarget();

  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = 'move';
  }
  event.preventDefault();
  event.stopPropagation();
  return true;
}

function handleGroupDragOverGroup(event, section, header) {
  const draggedGroupId = state.draggedGroupId;
  if (typeof draggedGroupId !== 'number') {
    return false;
  }

  const groupId = Number(section.dataset.groupId);
  if (Number.isNaN(groupId) || groupId === draggedGroupId) {
    if (currentDropTargetItem === section) {
      clearItemDropTarget();
    }
    return false;
  }

  if (!getGroupRange(draggedGroupId)) {
    return false;
  }

  const anchor = header || section;
  const position = determineDropPosition(event, anchor);
  setItemDropTarget(section, position, {
    type: 'group-reorder',
    targetType: 'group',
    targetId: groupId
  });
  clearGroupDropTarget();

  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = 'move';
  }
  event.preventDefault();
  event.stopPropagation();
  return true;
}

async function moveTabRelative(draggedTab, targetTab, position, context) {
  if (!context || context.type !== 'reorder') {
    return false;
  }

  const targetIndex = targetTab.index;
  const draggedIndex = draggedTab.index;

  let desiredIndex = position === 'after' ? targetIndex + 1 : targetIndex;

  if (draggedTab.windowId === targetTab.windowId && draggedIndex < desiredIndex) {
    desiredIndex -= 1;
  }

  desiredIndex = clampIndexForGroup(targetTab.groupId, desiredIndex);

  if (desiredIndex < 0) {
    desiredIndex = 0;
  }

  if (desiredIndex === draggedIndex) {
    return false;
  }

  try {
    await chromeAsync(chrome.tabs, 'move', draggedTab.id, { index: desiredIndex });
    return true;
  } catch (error) {
    console.error('Unable to reorder tab', { draggedTab, targetTab, position, error });
    return false;
  }
}

async function moveGroupRelative(groupId, target, position) {
  if (typeof groupId !== 'number' || !target || !position) {
    return false;
  }

  const range = getGroupRange(groupId);
  if (!range) {
    return false;
  }

  let desiredIndex = range.firstIndex;

  if (target.type === 'tab') {
    const targetTab = tabCache.get(Number(target.id));
    if (!targetTab || targetTab.groupId === groupId) {
      return false;
    }
    desiredIndex = position === 'after' ? targetTab.index + 1 : targetTab.index;
  } else if (target.type === 'group') {
    const targetGroupId = Number(target.id);
    if (Number.isNaN(targetGroupId) || targetGroupId === groupId) {
      return false;
    }
    const targetRange = getGroupRange(targetGroupId);
    if (!targetRange) {
      return false;
    }
    desiredIndex = position === 'after' ? targetRange.lastIndex + 1 : targetRange.firstIndex;
  } else {
    return false;
  }

  if (range.firstIndex < desiredIndex) {
    desiredIndex -= range.size;
  }

  if (desiredIndex < 0) {
    desiredIndex = 0;
  }

  if (desiredIndex === range.firstIndex) {
    return false;
  }

  const group = state.currentGroups.get(groupId);
  const moveOptions = { index: desiredIndex };
  const windowId = typeof group?.windowId === 'number' ? group.windowId : state.windowId;
  if (typeof windowId === 'number') {
    moveOptions.windowId = windowId;
  }

  try {
    await chromeAsync(chrome.tabGroups, 'move', groupId, moveOptions);
    return true;
  } catch (error) {
    console.error('Unable to move group', { groupId, target, position, error });
    return false;
  }
}

function handleTabItemDragMove(event, tabItem) {
  const draggedTab = getDraggedTab();
  if (!draggedTab) {
    return false;
  }

  const tabId = Number(tabItem.dataset.tabId);
  if (Number.isNaN(tabId)) {
    clearItemDropTarget();
    return false;
  }

  const targetTab = tabCache.get(tabId);
  const context = getDropContext(draggedTab, targetTab);
  if (!context) {
    clearItemDropTarget();
    return false;
  }

  if (context.type === 'reorder') {
    const position = determineDropPosition(event, tabItem);
    setItemDropTarget(tabItem, position, context);
    clearGroupDropTarget();

    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'move';
    }
    event.preventDefault();
    event.stopPropagation();
    return true;
  }

  if (context.type === 'unpin') {
    clearGroupDropTarget();
    clearItemDropTarget();
    currentDropTargetItem = tabItem;
    currentDropContext = context;
    tabItem.classList.add('drop-target-unpin');
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'move';
    }
    event.preventDefault();
    event.stopPropagation();
    return true;
  }

  return false;
}

function handleTabItemDragLeave(event, tabItem) {
  const related = event.relatedTarget;
  if (related && tabItem.contains(related)) {
    return;
  }
  if (currentDropTargetItem === tabItem) {
    clearItemDropTarget();
  }
}

async function handleTabItemDrop(event, tabItem) {
  const draggedTab = getDraggedTab();
  if (!draggedTab) {
    return false;
  }

  const targetId = Number(tabItem.dataset.tabId);
  if (Number.isNaN(targetId)) {
    return false;
  }

  const targetTab = tabCache.get(targetId);
  const context = currentDropContext || getDropContext(draggedTab, targetTab);
  if (context && context.type === 'reorder') {
    const position = currentDropTargetItem === tabItem && currentDropPosition ? currentDropPosition : determineDropPosition(event, tabItem);

    clearDropIndicators();
    state.draggedTabId = null;

    try {
      const moved = await moveTabRelative(draggedTab, targetTab, position, context);
      if (moved) {
        scheduleRefresh();
      }
      return moved;
    } catch (error) {
      console.error('Unable to complete tab drop', error);
      return false;
    }
  }

  if (context && context.type === 'unpin') {
    clearDropIndicators();
    state.draggedTabId = null;
    try {
      const changed = await setTabPinned(draggedTab, false);
      if (changed) {
        scheduleRefresh();
      }
      return changed;
    } catch (error) {
      console.error('Unable to unpin tab via drop', error);
      return false;
    }
  }

  return false;
}

async function handleGroupDrop(event) {
  const groupId = state.draggedGroupId;
  if (typeof groupId !== 'number') {
    return false;
  }

  const completeDrop = async (target, indicatorElement, anchorElement = indicatorElement) => {
    if (!target || !indicatorElement || !anchorElement) {
      return false;
    }

    const position = currentDropTargetItem === indicatorElement && currentDropPosition
      ? currentDropPosition
      : determineDropPosition(event, anchorElement);

    event.preventDefault();
    event.stopPropagation();

    clearDropIndicators();
    state.draggedGroupId = null;

    try {
      const moved = await moveGroupRelative(groupId, target, position);
      if (moved) {
        scheduleRefresh();
      }
      return true;
    } catch (error) {
      console.error('Unable to complete group drop', error);
      return true;
    }
  };

  const tabItem = event.target.closest('.tab-item');
  if (tabItem) {
    const targetTabId = Number(tabItem.dataset.tabId);
    if (!Number.isNaN(targetTabId)) {
      return completeDrop({ type: 'tab', id: targetTabId }, tabItem);
    }
    return false;
  }

  const section = event.target.closest('.tab-group');
  if (section) {
    const targetGroupId = Number(section.dataset.groupId);
    if (!Number.isNaN(targetGroupId) && targetGroupId !== groupId) {
      const header = section.querySelector('.group-header');
      return completeDrop({ type: 'group', id: targetGroupId }, section, header || section);
    }
  }

  if (currentDropContext?.type === 'group-reorder' && currentDropTargetItem) {
    const context = currentDropContext;
    if (context.targetType === 'tab') {
      const targetTabId = Number(context.targetId);
      if (!Number.isNaN(targetTabId)) {
        return completeDrop({ type: 'tab', id: targetTabId }, currentDropTargetItem);
      }
    } else if (context.targetType === 'group') {
      const targetGroupId = Number(context.targetId);
      if (!Number.isNaN(targetGroupId) && targetGroupId !== groupId) {
        const header = currentDropTargetItem.querySelector?.('.group-header');
        return completeDrop({ type: 'group', id: targetGroupId }, currentDropTargetItem, header || currentDropTargetItem);
      }
    }
  }

  clearDropIndicators();
  state.draggedGroupId = null;
  return false;
}

function promptRenameTab(tabId) {
  const tab = tabCache.get(tabId);
  if (!tab) {
    return;
  }
  if (state.editingTabId !== null && state.editingTabId !== tab.id) {
    const activeInput = document.querySelector('.tab-rename-input');
    if (activeInput) {
      activeInput.blur();
    } else {
      state.editingTabId = null;
    }
  }
  state.editingTabId = tab.id;
  closeContextMenu();
  scheduleRefresh();
}

function handleRenameKeydown(event) {
  if (event.key === 'Enter') {
    event.preventDefault();
    handleRenameCommit(event);
  } else if (event.key === 'Escape') {
    event.preventDefault();
    state.editingTabId = null;
    scheduleRefresh();
  }
}

function handleRenameCommit(event) {
  const input = event.target;
  if (!(input instanceof HTMLElement) || input.tagName.toLowerCase() !== 'input') {
    return;
  }
  const tabId = Number(input.dataset.tabId);
  if (Number.isNaN(tabId)) {
    state.editingTabId = null;
    scheduleRefresh();
    return;
  }

  const value = input.value.trim();
  if (value) {
    state.customTitles.set(tabId, value);
  } else {
    state.customTitles.delete(tabId);
  }

  state.editingTabId = null;
  scheduleRefresh();
}

function getNextGroupColorKey() {
  if (!GROUP_COLOR_KEYS.length) {
    return 'grey';
  }
  const colorKey = GROUP_COLOR_KEYS[groupColorIndex % GROUP_COLOR_KEYS.length];
  groupColorIndex += 1;
  return colorKey;
}

function closeContextMenu() {
  if (!contextMenuEl) {
    return;
  }
  contextMenuEl.remove();
  contextMenuEl = null;

  document.removeEventListener('pointerdown', handleContextMenuPointerDown, true);
  document.removeEventListener('keydown', handleContextMenuKeydown, true);
  window.removeEventListener('resize', closeContextMenu);
  window.removeEventListener('blur', closeContextMenu);
}

function handleContextMenuPointerDown(event) {
  if (!contextMenuEl) {
    return;
  }
  if (contextMenuEl.contains(event.target)) {
    return;
  }
  closeContextMenu();
}

function handleContextMenuKeydown(event) {
  if (event.key === 'Escape') {
    closeContextMenu();
  }
}

function isContextMenuKey(event) {
  if (!event) {
    return false;
  }
  if (event.key === 'ContextMenu') {
    return true;
  }
  return event.shiftKey && (event.key === 'F10' || event.key === 'f10');
}

function setPinnedDropTarget(active) {
  if (!pinnedArea) {
    return;
  }
  if (active) {
    if (!pinnedDropActive) {
      pinnedDropActive = true;
      pinnedArea.classList.add('is-drop-target');
    }
  } else if (pinnedDropActive) {
    pinnedDropActive = false;
    pinnedArea.classList.remove('is-drop-target');
  }
}

function clearDropIndicators() {
  if (currentDropTargetSection) {
    const header = currentDropTargetSection.querySelector('.group-header');
    if (header) {
      header.classList.remove('is-drop-target');
    }
    currentDropTargetSection = null;
  }

  if (currentDropTargetItem) {
    currentDropTargetItem.classList.remove('drop-target-before', 'drop-target-after', 'drop-target-unpin');
    currentDropTargetItem = null;
    currentDropPosition = null;
  }
  currentDropContext = null;
  setPinnedDropTarget(false);

  const draggingPinned = pinnedContainer?.querySelector('.pinned-tab.dragging');
  if (draggingPinned) {
    draggingPinned.classList.remove('dragging');
  }
}

function setGroupDropTarget(section) {
  if (currentDropTargetSection === section) {
    return;
  }
  clearGroupDropTarget();
  if (!section) {
    return;
  }
  currentDropTargetSection = section;
  const header = section.querySelector('.group-header');
  if (header) {
    header.classList.add('is-drop-target');
  }
}

function clearGroupDropTarget() {
  if (!currentDropTargetSection) {
    return;
  }
  const header = currentDropTargetSection.querySelector('.group-header');
  if (header) {
    header.classList.remove('is-drop-target');
  }
  currentDropTargetSection = null;
}

function setItemDropTarget(item, position, context) {
  if (currentDropTargetItem === item && currentDropPosition === position && currentDropContext?.type === context?.type && currentDropContext?.groupId === context?.groupId) {
    return;
  }
  clearItemDropTarget();
  if (!item) {
    return;
  }
  currentDropTargetItem = item;
  currentDropPosition = position;
  currentDropContext = context || null;
  item.classList.add(position === 'after' ? 'drop-target-after' : 'drop-target-before');
}

function clearItemDropTarget() {
  if (!currentDropTargetItem) {
    return;
  }
  currentDropTargetItem.classList.remove('drop-target-before', 'drop-target-after', 'drop-target-unpin');
  currentDropTargetItem = null;
  currentDropPosition = null;
  currentDropContext = null;
}

function openTabMenu(tab, positioning = {}) {
  if (!tab) {
    return;
  }

  const options = buildTabMenuOptions(tab);
  if (!options.length) {
    return;
  }

  closeContextMenu();

  const menu = document.createElement('div');
  menu.className = 'tab-menu';
  menu.tabIndex = -1;
  menu.setAttribute('role', 'menu');

  for (const option of options) {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('role', 'menuitem');
    button.dataset.action = option.label;

    if (option.color) {
      const chip = document.createElement('span');
      chip.className = 'group-chip';
      chip.style.background = option.color;
      button.appendChild(chip);
    }

    const label = document.createElement('span');
    label.textContent = option.label;
    button.appendChild(label);

    button.addEventListener('click', async (event) => {
      event.stopPropagation();
      closeContextMenu();
      try {
        const shouldRefresh = await option.action();
        if (shouldRefresh) {
          scheduleRefresh();
        }
      } catch (error) {
        console.error('Tab menu action failed:', error);
      }
    });

    menu.appendChild(button);
  }

  menu.addEventListener('pointerdown', (event) => {
    event.stopPropagation();
  });
  menu.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    event.stopPropagation();
  });

  menu.style.visibility = 'hidden';
  document.body.appendChild(menu);

  const { offsetWidth, offsetHeight } = menu;
  let left = 0;
  let top = 0;

  if (positioning.point) {
    left = positioning.point.x;
    top = positioning.point.y;
  } else if (positioning.anchor) {
    const rect = positioning.anchor.getBoundingClientRect();
    left = rect.left;
    top = rect.bottom + 6;
  } else {
    const rect = collectionsContainer.getBoundingClientRect();
    left = rect.left + rect.width / 2 - offsetWidth / 2;
    top = rect.top + rect.height / 2 - offsetHeight / 2;
  }

  left = Math.min(left, window.innerWidth - offsetWidth - 8);
  left = Math.max(8, left);
  top = Math.min(top, window.innerHeight - offsetHeight - 8);
  top = Math.max(8, top);

  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  menu.style.visibility = 'visible';

  contextMenuEl = menu;

  requestAnimationFrame(() => {
    menu.focus({ preventScroll: true });
  });

  document.addEventListener('pointerdown', handleContextMenuPointerDown, true);
  document.addEventListener('keydown', handleContextMenuKeydown, true);
  window.addEventListener('resize', closeContextMenu);
  window.addEventListener('blur', closeContextMenu);
}

function buildTabMenuOptions(tab) {
  const options = [];
  const tabId = Number(tab.id);
  if (Number.isNaN(tabId)) {
    return options;
  }

  options.push({
    label: tab.pinned ? 'Unpin tab' : 'Pin tab',
    action: () => setTabPinned(tab, !tab.pinned)
  });

  options.push({
    label: 'Duplicate tab',
    action: () => duplicateTab(tab)
  });

  options.push({
    label: 'Rename tab…',
    action: async () => {
      promptRenameTab(tab.id);
      return false;
    }
  });

  if (!tab.pinned) {
    if (tab.groupId !== -1) {
      options.push({
        label: 'Remove from group',
        action: () => removeTabFromGroup(tab)
      });
    }

    const groups = state.currentGroups || new Map();
    for (const [groupId, group] of groups) {
      if (groupId === tab.groupId) {
        continue;
      }
      const title = group?.title?.trim() || 'Untitled group';
      const colorHex = GROUP_COLORS[group?.color] || GROUP_COLORS.grey;
      options.push({
        label: `Move to group ${title}`,
        action: () => moveTabToGroup(tab, groupId),
        color: colorHex
      });
    }

    options.push({
      label: 'Create new group...',
      action: () => createGroupFromTab(tab)
    });
  }

  return options;
}

async function setTabPinned(tab, shouldPin) {
  const tabId = Number(tab.id);
  if (Number.isNaN(tabId)) {
    return false;
  }
  try {
    await chromeAsync(chrome.tabs, 'update', tabId, { pinned: shouldPin });
    return true;
  } catch (error) {
    console.error('Unable to change pin state for tab', tabId, error);
    return false;
  }
}

async function removeTabFromGroup(tab) {
  const tabId = Number(tab.id);
  if (Number.isNaN(tabId)) {
    return false;
  }
  try {
    await chromeAsync(chrome.tabs, 'ungroup', tabId);
    return true;
  } catch (error) {
    console.error('Unable to remove tab from group', tabId, error);
    return false;
  }
}

async function moveTabToGroup(tab, groupId) {
  const tabId = Number(tab.id);
  const targetGroupId = Number(groupId);
  if (Number.isNaN(tabId) || Number.isNaN(targetGroupId)) {
    return false;
  }
  if (tab.pinned || tab.groupId === targetGroupId) {
    return false;
  }
  try {
    await chromeAsync(chrome.tabs, 'group', {
      groupId: targetGroupId,
      tabIds: [tabId]
    });
    return true;
  } catch (error) {
    console.error('Unable to move tab to group', { tabId, targetGroupId, error });
    return false;
  }
}

async function createGroupFromTab(tab) {
  const tabId = Number(tab.id);
  if (Number.isNaN(tabId)) {
    return false;
  }

  const defaultTitle = tab.title?.trim() ? tab.title.trim().slice(0, 32) : 'New group';
  const input = window.prompt('Name the new group', defaultTitle);
  if (input === null) {
    return false;
  }

  const title = input.trim() || defaultTitle;
  const colorKey = getNextGroupColorKey();

  const createProperties = {};
  const windowId = typeof tab.windowId === 'number' ? tab.windowId : state.windowId;
  if (typeof windowId === 'number') {
    createProperties.windowId = windowId;
  }

  const groupOptions = { tabIds: [tabId] };
  if (Object.keys(createProperties).length) {
    groupOptions.createProperties = createProperties;
  }

  try {
    const groupId = await chromeAsync(chrome.tabs, 'group', groupOptions);
    await chromeAsync(chrome.tabGroups, 'update', groupId, {
      title,
      color: colorKey
    });
    return true;
  } catch (error) {
    console.error('Unable to create group for tab', tabId, error);
    return false;
  }
}

async function duplicateTab(tab) {
  const tabId = Number(tab.id);
  if (Number.isNaN(tabId)) {
    return false;
  }
  try {
    await chromeAsync(chrome.tabs, 'duplicate', tabId);
    return true;
  } catch (error) {
    console.error('Unable to duplicate tab', tabId, error);
    return false;
  }
}

async function closeTab(tabId) {
  const id = Number(tabId);
  if (Number.isNaN(id)) {
    return false;
  }
  try {
    await chromeAsync(chrome.tabs, 'remove', id);
    return true;
  } catch (error) {
    console.error('Unable to close tab', id, error);
    return false;
  }
}

async function activateTab(tabId) {
  try {
    await chromeAsync(chrome.tabs, 'update', Number(tabId), { active: true });
  } catch (error) {
    console.error('Unable to activate tab', tabId, error);
  }
}

function attachEventHandlers() {
  pinnedContainer.addEventListener('click', (event) => {
    const button = event.target.closest('.pinned-tab');
    if (!button) {
      return;
    }
    const tabId = button.dataset.tabId;
    if (tabId) {
      activateTab(tabId);
    }
  });

  pinnedContainer.addEventListener('contextmenu', (event) => {
    const button = event.target.closest('.pinned-tab');
    if (!button) {
      return;
    }
    event.preventDefault();
    const tabId = Number(button.dataset.tabId);
    const tab = tabCache.get(tabId);
    if (tab) {
      openTabMenu(tab, { point: { x: event.clientX, y: event.clientY } });
    }
  });

  pinnedContainer.addEventListener('keydown', (event) => {
    if (!isContextMenuKey(event)) {
      return;
    }
    const button = event.target.closest('.pinned-tab');
    if (!button) {
      return;
    }
    event.preventDefault();
    const tabId = Number(button.dataset.tabId);
    const tab = tabCache.get(tabId);
    if (tab) {
      openTabMenu(tab, { anchor: button });
    }
  });

  pinnedContainer.addEventListener('dragstart', (event) => {
    const button = event.target.closest('.pinned-tab');
    if (!button) {
      return;
    }
    const tabId = Number(button.dataset.tabId);
    const tab = tabCache.get(tabId);
    if (!tab) {
      event.preventDefault();
      return;
    }

    closeContextMenu();
    clearDropIndicators();
    state.draggedGroupId = null;
    state.draggedTabId = tabId;
    button.classList.add('dragging');

    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      try {
        event.dataTransfer.setData(DRAG_MIME, String(tabId));
        if (!event.dataTransfer.getData('text/plain')) {
          event.dataTransfer.setData('text/plain', tab.title || tab.url || 'Tab');
        }
      } catch (error) {
        console.warn('Unable to set drag data for pinned tab:', error);
      }
    }
  });

  pinnedContainer.addEventListener('dragend', () => {
    state.draggedTabId = null;
    clearDropIndicators();
  });

  if (pinnedArea) {
    pinnedArea.addEventListener('dragenter', (event) => {
      const tab = getDraggedTab();
      if (!tab) {
        return;
      }
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'move';
      }
      event.preventDefault();
      event.stopPropagation();
      if (!tab.pinned) {
        setPinnedDropTarget(true);
      }
    });

    pinnedArea.addEventListener('dragover', (event) => {
      const tab = getDraggedTab();
      if (!tab) {
        return;
      }
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'move';
      }
      event.preventDefault();
      event.stopPropagation();
      if (!tab.pinned) {
        setPinnedDropTarget(true);
      } else {
        setPinnedDropTarget(false);
      }
    });

    pinnedArea.addEventListener('dragleave', (event) => {
      if (!pinnedArea.contains(event.relatedTarget)) {
        setPinnedDropTarget(false);
      }
    });

    pinnedArea.addEventListener('drop', async (event) => {
      const tab = getDraggedTab();
      if (!tab) {
        setPinnedDropTarget(false);
        return;
      }
      event.preventDefault();
      event.stopPropagation();

      clearDropIndicators();
      state.draggedTabId = null;

      if (tab.pinned) {
        return;
      }

      try {
        const pinned = await setTabPinned(tab, true);
        if (pinned) {
          scheduleRefresh();
        }
      } catch (error) {
        console.error('Unable to pin tab via drop', error);
      }
    });
  }

  collectionsContainer.addEventListener('click', async (event) => {
    const closeButton = event.target.closest('.tab-close');
    if (closeButton) {
      event.preventDefault();
      event.stopPropagation();
      const tabItem = closeButton.closest('.tab-item');
      const tabId = Number(tabItem?.dataset.tabId);
      if (!Number.isNaN(tabId)) {
        const closed = await closeTab(tabId);
        if (closed) {
          scheduleRefresh();
        }
      }
      return;
    }

    const groupHeader = event.target.closest('.group-header');
    if (groupHeader) {
      const section = groupHeader.closest('.tab-group');
      const groupId = Number(section?.dataset.groupId);
      if (!Number.isNaN(groupId)) {
        if (state.collapsedGroups.has(groupId)) {
          state.collapsedGroups.delete(groupId);
        } else {
          state.collapsedGroups.add(groupId);
        }
        scheduleRefresh();
      }
      return;
    }


    const mainButton = event.target.closest('.tab-main');
    if (!mainButton) {
      return;
    }
    if (event.detail > 1) {
      return;
    }
    if (mainButton.classList.contains('is-editing')) {
      return;
    }
    const tabItem = mainButton.closest('.tab-item');
    if (!tabItem) {
      return;
    }
    const tabId = tabItem.dataset.tabId;
    if (tabId) {
      activateTab(tabId);
    }
  });

  collectionsContainer.addEventListener('keydown', (event) => {
    const mainButton = event.target.closest('.tab-main');
    if (!mainButton || mainButton.classList.contains('is-editing')) {
      return;
    }
    if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
      event.preventDefault();
      const tabItem = mainButton.closest('.tab-item');
      if (!tabItem) {
        return;
      }
      const tabId = tabItem.dataset.tabId;
      if (tabId) {
        activateTab(tabId);
      }
    }
  });

  collectionsContainer.addEventListener('contextmenu', (event) => {
    const tabItem = event.target.closest('.tab-item');
    if (!tabItem) {
      return;
    }
    event.preventDefault();
    const tabId = Number(tabItem.dataset.tabId);
    const tab = tabCache.get(tabId);
    if (tab) {
      openTabMenu(tab, { point: { x: event.clientX, y: event.clientY } });
    }
  });

  collectionsContainer.addEventListener('keydown', (event) => {
    if (!isContextMenuKey(event)) {
      return;
    }
    const tabItem = event.target.closest('.tab-item');
    if (!tabItem) {
      return;
    }
    event.preventDefault();
    const tabId = Number(tabItem.dataset.tabId);
    const tab = tabCache.get(tabId);
    if (tab) {
      const anchor = event.target.closest('.tab-main') || tabItem;
      openTabMenu(tab, { anchor });
    }
  });

  collectionsContainer.addEventListener('dblclick', (event) => {
    const mainButton = event.target.closest('.tab-main');
    if (!mainButton) {
      return;
    }
    if (mainButton.classList.contains('is-editing')) {
      return;
    }
    const tabItem = mainButton.closest('.tab-item');
    if (!tabItem) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const tabId = Number(tabItem.dataset.tabId);
    if (Number.isNaN(tabId)) {
      return;
    }
    if (state.editingTabId === tabId) {
      return;
    }
    closeContextMenu();
    promptRenameTab(tabId);
  });

  collectionsContainer.addEventListener('dragstart', (event) => {
    const groupHeader = event.target.closest('.group-header');
    if (groupHeader && groupHeader.draggable) {
      const groupId = Number(groupHeader.dataset.groupId);
      if (!Number.isNaN(groupId)) {
        closeContextMenu();
        clearDropIndicators();
        state.draggedTabId = null;
        state.draggedGroupId = groupId;
        groupHeader.classList.add('dragging');

        if (event.dataTransfer) {
          event.dataTransfer.effectAllowed = 'move';
          try {
            event.dataTransfer.setData('application/x-side-group-id', String(groupId));
            const group = state.currentGroups.get(groupId);
            event.dataTransfer.setData('text/plain', group?.title || 'Tab Group');
          } catch (error) {
            console.warn('Unable to set drag data for group:', error);
          }
        }
        return;
      }
    }

    const tabItem = event.target.closest('.tab-item');
    if (!tabItem || !tabItem.draggable) {
      return;
    }

    const tabId = Number(tabItem.dataset.tabId);
    const tab = tabCache.get(tabId);
    if (!tab || tab.pinned) {
      event.preventDefault();
      return;
    }

    closeContextMenu();
    clearDropIndicators();
    state.draggedTabId = tabId;
    tabItem.classList.add('dragging');

    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      try {
        event.dataTransfer.setData(DRAG_MIME, String(tabId));
        if (!event.dataTransfer.getData('text/plain')) {
          event.dataTransfer.setData('text/plain', tab.title || tab.url || 'Tab');
        }
      } catch (error) {
        console.warn('Unable to set drag data:', error);
      }
    }
  });

  collectionsContainer.addEventListener('dragend', (event) => {
    const groupHeader = event.target.closest('.group-header');
    if (groupHeader) {
      groupHeader.classList.remove('dragging');
    }

    const tabItem = event.target.closest('.tab-item');
    if (tabItem) {
      tabItem.classList.remove('dragging');
    }

    state.draggedTabId = null;
    state.draggedGroupId = null;
    clearDropIndicators();
  });

  collectionsContainer.addEventListener('dragenter', (event) => {
    const draggedGroup = getDraggedGroup();
    const tabItem = event.target.closest('.tab-item');
    if (tabItem) {
      if (draggedGroup && handleGroupDragOverTab(event, tabItem)) {
        return;
      }
      if (handleTabItemDragMove(event, tabItem)) {
        return;
      }
    }

    const header = event.target.closest('.group-header');
    if (!header) {
      return;
    }

    const section = header.closest('.tab-group');
    if (!section) {
      return;
    }

    if (draggedGroup && handleGroupDragOverGroup(event, section, header)) {
      return;
    }

    const draggedTab = getDraggedTab();
    if (!draggedTab || draggedTab.pinned) {
      return;
    }

    const groupId = Number(section.dataset.groupId);
    if (Number.isNaN(groupId) || groupId === -1 || draggedTab.groupId === groupId) {
      return;
    }

    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'move';
    }
    event.preventDefault();
    event.stopPropagation();
    setGroupDropTarget(section);
    clearItemDropTarget();
  });

  collectionsContainer.addEventListener('dragover', (event) => {
    const draggedGroup = getDraggedGroup();
    const tabItem = event.target.closest('.tab-item');
    if (tabItem) {
      if (draggedGroup && handleGroupDragOverTab(event, tabItem)) {
        return;
      }
      if (handleTabItemDragMove(event, tabItem)) {
        return;
      }
    }

    const header = event.target.closest('.group-header');
    if (!header) {
      return;
    }

    const section = header.closest('.tab-group');
    if (!section) {
      return;
    }

    if (draggedGroup && handleGroupDragOverGroup(event, section, header)) {
      return;
    }

    const draggedTab = getDraggedTab();
    if (!draggedTab || draggedTab.pinned) {
      return;
    }

    const groupId = Number(section.dataset.groupId);
    if (Number.isNaN(groupId) || groupId === -1 || draggedTab.groupId === groupId) {
      return;
    }

    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'move';
    }
    event.preventDefault();
    event.stopPropagation();
    setGroupDropTarget(section);
    clearItemDropTarget();
  });

  collectionsContainer.addEventListener('dragleave', (event) => {
    const tabItem = event.target.closest('.tab-item');
    if (tabItem) {
      event.stopPropagation();
      handleTabItemDragLeave(event, tabItem);
      return;
    }

    const header = event.target.closest('.group-header');
    if (!header) {
      return;
    }

    const section = header.closest('.tab-group');
    if (!section) {
      return;
    }

    const related = event.relatedTarget;
    if (related && section.contains(related)) {
      return;
    }

    const draggedGroup = getDraggedGroup();
    if (draggedGroup) {
      event.stopPropagation();
      if (currentDropTargetItem === section) {
        clearItemDropTarget();
      }
      return;
    }

    event.stopPropagation();
    if (currentDropTargetSection === section) {
      clearGroupDropTarget();
    }
  });

  collectionsContainer.addEventListener('drop', async (event) => {
    if (typeof state.draggedGroupId === 'number') {
      const handledGroup = await handleGroupDrop(event);
      if (handledGroup) {
        return;
      }
    }

    const tabItem = event.target.closest('.tab-item');
    if (tabItem) {
      const handled = await handleTabItemDrop(event, tabItem);
      if (handled) {
        return;
      }
    }

    const header = event.target.closest('.group-header');
    if (!header) {
      const draggedTab = getDraggedTab();
      if (draggedTab && draggedTab.pinned) {
        event.preventDefault();
        event.stopPropagation();
        try {
          const changed = await setTabPinned(draggedTab, false);
          if (changed) {
            scheduleRefresh();
          }
        } catch (error) {
          console.error('Unable to unpin tab via drop', error);
        }
      }
      clearDropIndicators();
      state.draggedTabId = null;
      return;
    }

    const section = header.closest('.tab-group');
    if (!section) {
      return;
    }

    const draggedTab = getDraggedTab();
    if (!draggedTab || draggedTab.pinned) {
      return;
    }

    const groupId = Number(section.dataset.groupId);
    if (Number.isNaN(groupId) || groupId === -1 || draggedTab.groupId === groupId) {
      clearDropIndicators();
      state.draggedTabId = null;
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const draggedItem = collectionsContainer.querySelector(`.tab-item[data-tab-id="${draggedTab.id}"]`);
    if (draggedItem) {
      draggedItem.classList.remove('dragging');
    }

    clearDropIndicators();
    state.draggedTabId = null;

    try {
      const moved = await moveTabToGroup(draggedTab, groupId);
      if (moved) {
        scheduleRefresh();
      }
    } catch (error) {
      console.error('Unable to drop tab into group', error);
    }
  });

  const handleScroll = () => {
    if (contextMenuEl) {
      closeContextMenu();
    }
    clearDropIndicators();
  };

  collectionsContainer.addEventListener('scroll', handleScroll);
  pinnedContainer.addEventListener('scroll', handleScroll);

  chrome.tabs.onCreated.addListener(handleTabEvent);
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (!tab || changeInfo.status === 'loading') {
      return;
    }
    handleTabEvent(tabId, tab.windowId);
  });
  chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
    state.customTitles.delete(tabId);
    if (state.editingTabId === tabId) {
      state.editingTabId = null;
    }
    handleTabEvent(tabId, removeInfo.windowId);
  });
  chrome.tabs.onMoved.addListener((tabId, moveInfo) => handleTabEvent(tabId, moveInfo.windowId));
  chrome.tabs.onAttached.addListener((tabId, attachInfo) => handleTabEvent(tabId, attachInfo.newWindowId));
  chrome.tabs.onDetached.addListener((tabId, detachInfo) => {
    if (detachInfo.oldWindowId === state.windowId) {
      scheduleRefresh();
    }
  });
  chrome.tabs.onActivated.addListener((activeInfo) => {
    if (typeof activeInfo.windowId === 'number') {
      state.windowId = activeInfo.windowId;
    }
    handleTabEvent(activeInfo.tabId, activeInfo.windowId);
  });

  chrome.tabGroups.onCreated.addListener((group) => handleTabEvent(null, group.windowId));
  chrome.tabGroups.onUpdated.addListener((group) => handleTabEvent(null, group.windowId));
  chrome.tabGroups.onMoved.addListener((group) => handleTabEvent(null, group.windowId));
  chrome.tabGroups.onRemoved.addListener((group) => handleTabEvent(null, group.windowId));
}

function handleTabEvent(_tabId, windowId) {
  if (typeof windowId !== 'number' || windowId === state.windowId) {
    scheduleRefresh();
  }
}

async function init() {
  attachEventHandlers();
  scheduleRefresh();
}

init().catch((error) => {
  console.error('Failed to initialize side panel:', error);
});
