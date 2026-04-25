const API_BASE_URL = 'http://localhost:4000';
const TOKEN_KEY = 'taskflow_token';
let serverTasks = [];
let currentTasks = [];
let currentFilter = 'visible';
let currentSearchTerm = '';
let currentFromDate = '';
let currentToDate = '';
let availableUsers = [];

function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

function setToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
}

function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

function parseJwtPayload(token) {
  if (!token) return null;
  const tokenParts = token.split('.');
  if (tokenParts.length < 2) return null;

  try {
    const normalized = tokenParts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    return JSON.parse(atob(padded));
  } catch (err) {
    return null;
  }
}

function getCurrentUserId() {
  const payload = parseJwtPayload(getToken());
  const rawUserId = payload && (payload.email || payload.username);
  if (typeof rawUserId !== 'string') {
    return '';
  }
  return rawUserId.trim().toLowerCase();
}

function toIsoDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}

async function apiRequest(path, options = {}) {
  const token = getToken();
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers
  });

  let data = {};
  try {
    data = await response.json();
  } catch (err) {
    data = {};
  }

  return { response, data };
}

function showMessage(elementId, message, isError = false) {
  const element = document.getElementById(elementId);
  if (!element) return;
  element.textContent = message;
  element.style.color = isError ? '#b91c1c' : '#1d4ed8';
}

async function register(email, password) {
  const { response, data } = await apiRequest('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, password })
  });

  if (!response.ok) {
    throw new Error(data.message || 'Register failed');
  }

  return data;
}

async function login(email, password) {
  const { response, data } = await apiRequest('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password })
  });

  if (!response.ok) {
    throw new Error(data.message || 'Login failed');
  }

  return data;
}

function filterTasksBySearch(tasks, searchTerm) {
  const normalizedTerm = String(searchTerm || '').trim().toLowerCase();
  if (!normalizedTerm) {
    return tasks;
  }

  return tasks.filter((task) => String(task.title || '').toLowerCase().includes(normalizedTerm));
}

function applyTaskFilters() {
  const visibleTasks = filterTasksBySearch(serverTasks, currentSearchTerm);
  renderTasks(visibleTasks);
}

function formatDisplayDate(value) {
  if (!value) return 'N/A';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'N/A';
  return date.toLocaleString();
}

function getProgressPercent(progressStatus) {
  if (progressStatus === 'completed') return 100;
  if (progressStatus === 'in_progress') return 50;
  return 0;
}

function getProgressLabel(progressStatus) {
  if (progressStatus === 'in_progress') return 'In Progress';
  if (progressStatus === 'completed') return 'Completed';
  return 'Not Started';
}

function isTaskOwner(task, currentUser) {
  return String(task.createdBy || '').toLowerCase() === currentUser;
}

function canCurrentUserModifyTask(task, currentUser) {
  if (isTaskOwner(task, currentUser)) {
    return true;
  }

  if (task.visibility !== 'selected') {
    return false;
  }

  const allowedUsers = Array.isArray(task.allowedUsers) ? task.allowedUsers : [];
  const normalizedAllowedUsers = allowedUsers.map((user) => String(user || '').trim().toLowerCase());
  return normalizedAllowedUsers.includes(currentUser);
}

function canCurrentUserModifyTask(task, currentUser) {
  if (isTaskOwner(task, currentUser)) {
    return true;
  }

  if (task.visibility !== 'selected') {
    return false;
  }

  const allowedUsers = Array.isArray(task.allowedUsers) ? task.allowedUsers : [];
  return allowedUsers
    .map((user) => String(user || '').trim().toLowerCase())
    .includes(currentUser);
}

function renderTasks(tasks) {
  const list = document.getElementById('task-list');
  if (!list) return;

  currentTasks = Array.isArray(tasks) ? tasks : [];
  updateTaskMetrics(currentTasks);

  if (currentTasks.length === 0) {
    const hasActiveSearch = Boolean(String(currentSearchTerm || '').trim());
    const title = hasActiveSearch
      ? 'No matching tasks found'
      : 'No tasks yet. Create your first task 🚀';
    const subtitle = hasActiveSearch
      ? 'Try a different search term or clear the search input.'
      : 'Create your first task and start tracking progress.';

    list.innerHTML = `
      <li class="task-item empty-state">
        <div class="task-title">${escapeHtml(title)}</div>
        <p class="task-description">${escapeHtml(subtitle)}</p>
      </li>
    `;
    return;
  }

  const currentUser = getCurrentUserId();
  list.innerHTML = currentTasks.map((task) => `
    <li class="task-item ${isCompletedTask(task.status) ? 'is-completed' : ''} ${task.status === 'cancelled' ? 'is-cancelled' : ''}">
      <div class="task-main-row">
        <input
          class="task-check"
          type="checkbox"
          data-task-id="${task.id}"
          ${isCompletedTask(task.status) ? 'checked' : ''}
          ${(task.status === 'cancelled' || !canCurrentUserModifyTask(task, currentUser)) ? 'disabled' : ''}
          aria-label="Task completion status"
        />
        <div class="task-content">
          <div class="task-title">${escapeHtml(task.title || 'Untitled Task')}</div>
          <p class="task-description">${escapeHtml(task.description || 'No description provided.')}</p>
          <p class="task-owner">Created by: ${escapeHtml(task.createdBy || 'unknown')}</p>
          <p class="task-owner">Created at: ${escapeHtml(formatDisplayDate(task.createdAt))}</p>
          ${task.visibility === 'selected' && isTaskOwner(task, currentUser) ? `<p class="task-owner">Allowed users: ${escapeHtml((task.allowedUsers || []).join(', ') || 'None')}</p>` : ''}
          ${task.status === 'cancelled' ? `
            <p class="task-owner">Cancelled by: ${escapeHtml(task.cancelledBy || 'unknown')}</p>
            <p class="task-owner">Cancelled at: ${escapeHtml(formatDisplayDate(task.cancelledAt))}</p>
            <p class="task-cancelled-reason">Reason: ${escapeHtml(task.cancelledReason || 'No reason provided')}</p>
          ` : ''}
          <div class="task-meta">
            <span>Status</span>
            <span class="status-badge ${getStatusClass(task.status)}">${escapeHtml(task.status || 'pending')}</span>
            <span class="visibility-badge ${getVisibilityClass(task.visibility)}">${escapeHtml(task.visibility || 'private')}</span>
          </div>
          <div class="task-progress">
            <label class="progress-label" for="progress-${task.id}">Progress</label>
            <select
              id="progress-${task.id}"
              class="task-progress-select"
              data-progress-id="${task.id}"
              ${canCurrentUserModifyTask(task, currentUser) ? '' : 'disabled'}
            >
              <option value="not_started" ${task.progressStatus === 'not_started' ? 'selected' : ''}>Not Started</option>
              <option value="in_progress" ${task.progressStatus === 'in_progress' ? 'selected' : ''}>In Progress</option>
              <option value="completed" ${task.progressStatus === 'completed' ? 'selected' : ''}>Completed</option>
            </select>
            <div class="mini-progress-track">
              <div class="mini-progress-fill" style="width:${getProgressPercent(task.progressStatus)}%;"></div>
            </div>
            <span class="progress-value">${getProgressLabel(task.progressStatus)} (${getProgressPercent(task.progressStatus)}%)</span>
          </div>
          <div class="task-actions">
            <button
              type="button"
              class="task-cancel-btn ${canCurrentUserModifyTask(task, currentUser) && task.status !== 'cancelled' ? '' : 'is-disabled'}"
              data-cancel-id="${task.id}"
              ${canCurrentUserModifyTask(task, currentUser) && task.status !== 'cancelled' ? '' : 'disabled'}
            >
              Cancel Task
            </button>
            <button
              type="button"
              class="task-delete-btn ${isTaskOwner(task, currentUser) ? '' : 'is-disabled'}"
              data-delete-id="${task.id}"
              ${isTaskOwner(task, currentUser) ? '' : 'disabled'}
            >
              Delete
            </button>
          </div>
        </div>
      </div>
    </li>
  `).join('');

  list.querySelectorAll('.task-check').forEach((checkbox) => {
    checkbox.addEventListener('change', async (event) => {
      const taskId = Number(event.target.dataset.taskId);
      const nextStatus = event.target.checked ? 'completed' : 'pending';
      await toggleTaskStatus(taskId, nextStatus);
    });
  });

  list.querySelectorAll('.task-progress-select').forEach((select) => {
    select.addEventListener('change', async (event) => {
      const taskId = Number(event.target.dataset.progressId);
      const nextProgressStatus = event.target.value;
      await updateTaskProgress(taskId, nextProgressStatus);
    });
  });

  list.querySelectorAll('.task-cancel-btn').forEach((button) => {
    button.addEventListener('click', async (event) => {
      if (event.currentTarget.disabled) {
        return;
      }
      const taskId = Number(event.currentTarget.dataset.cancelId);
      const reason = window.prompt('Please enter cancellation reason:');
      if (reason === null) {
        return;
      }
      await cancelTaskByReason(taskId, reason);
    });
  });

  list.querySelectorAll('.task-delete-btn').forEach((button) => {
    button.addEventListener('click', async (event) => {
      if (event.currentTarget.disabled) {
        return;
      }
      const taskId = Number(event.currentTarget.dataset.deleteId);
      await removeTask(taskId);
    });
  });
}

function getStatusClass(status) {
  const normalized = (status || 'pending').toLowerCase().replace(/\s+/g, '-');
  return `status-${normalized}`;
}

function getVisibilityClass(visibility) {
  const normalized = (visibility || 'private').toLowerCase().replace(/\s+/g, '-');
  return `visibility-${normalized}`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isCompletedTask(status) {
  const normalized = String(status || '').toLowerCase();
  return normalized === 'completed' || normalized === 'done';
}

function updateTaskMetrics(tasks) {
  const totalElement = document.getElementById('metric-total');
  const completedElement = document.getElementById('metric-completed');
  const percentElement = document.getElementById('metric-percent');
  const progressFillElement = document.getElementById('progress-fill');
  if (!totalElement || !completedElement) return;

  const taskList = Array.isArray(tasks) ? tasks : [];
  const completedCount = taskList.filter((task) => isCompletedTask(task.status)).length;
  const completionPercent = taskList.length === 0
    ? 0
    : Math.round((completedCount / taskList.length) * 100);

  totalElement.textContent = String(taskList.length);
  completedElement.textContent = String(completedCount);

  if (percentElement) {
    percentElement.textContent = `${completionPercent}%`;
  }

  if (progressFillElement) {
    progressFillElement.style.width = `${completionPercent}%`;
  }
}

async function loadTasks() {
  const params = new URLSearchParams();
  params.set('filter', currentFilter);
  if (currentFromDate) params.set('from', currentFromDate);
  if (currentToDate) params.set('to', currentToDate);
  const { response, data } = await apiRequest(`/tasks?${params.toString()}`, { method: 'GET' });

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      clearToken();
      window.location.href = 'index.html';
      return;
    }
    throw new Error(data.message || 'Failed to load tasks');
  }

  serverTasks = Array.isArray(data) ? data : [];
  applyTaskFilters();
}

async function createTask(title, description) {
  const visibility = document.getElementById('visibility')?.value || 'private';
  const allowedUsersSelect = document.getElementById('allowed-users');
  const allowedUsers = visibility === 'selected' && allowedUsersSelect
    ? Array.from(allowedUsersSelect.selectedOptions).map((option) => option.value)
    : [];

  const { response, data } = await apiRequest('/tasks', {
    method: 'POST',
    body: JSON.stringify({
      title,
      description,
      visibility,
      allowedUsers,
      progressStatus: 'not_started'
    })
  });

  if (!response.ok) {
    throw new Error(data.message || 'Failed to create task');
  }

  return data;
}

async function updateTaskStatus(taskId, status) {
  const { response, data } = await apiRequest(`/tasks/${taskId}`, {
    method: 'PATCH',
    body: JSON.stringify({ status })
  });

  if (!response.ok) {
    throw new Error(data.message || 'Failed to update task status');
  }

  return data;
}

async function updateTaskProgressStatus(taskId, progressStatus) {
  const { response, data } = await apiRequest(`/tasks/${taskId}`, {
    method: 'PATCH',
    body: JSON.stringify({ progressStatus })
  });

  if (!response.ok) {
    throw new Error(data.message || 'Failed to update task progress');
  }

  return data;
}

async function cancelTask(taskId, reason) {
  const { response, data } = await apiRequest(`/tasks/${taskId}/cancel`, {
    method: 'PATCH',
    body: JSON.stringify({ reason })
  });

  if (!response.ok) {
    throw new Error(data.message || 'Failed to cancel task');
  }

  return data;
}

async function fetchUsers() {
  const { response, data } = await apiRequest('/users', { method: 'GET' });
  if (!response.ok) {
    throw new Error(data.message || 'Failed to load users');
  }
  return Array.isArray(data) ? data : [];
}

function populateAllowedUsers(users) {
  const select = document.getElementById('allowed-users');
  if (!select) return;
  select.innerHTML = users
    .map((user) => `<option value="${escapeHtml(user.email)}">${escapeHtml(user.email)}</option>`)
    .join('');
}

function toggleSelectedUsersInput() {
  const visibility = document.getElementById('visibility');
  const group = document.getElementById('selected-users-group');
  if (!visibility || !group) return;

  if (visibility.value === 'selected') {
    group.classList.remove('hidden');
  } else {
    group.classList.add('hidden');
  }
}

async function deleteTask(taskId) {
  const { response, data } = await apiRequest(`/tasks/${taskId}`, {
    method: 'DELETE'
  });

  if (!response.ok) {
    throw new Error(data.message || 'Failed to delete task');
  }

  return data;
}

async function toggleTaskStatus(taskId, nextStatus) {
  const previousServerTasks = serverTasks.map((task) => ({ ...task }));
  serverTasks = serverTasks.map((task) => {
    if (task.id === taskId) {
      return { ...task, status: nextStatus };
    }
    return task;
  });
  applyTaskFilters();

  try {
    const mappedProgressStatus = nextStatus === 'completed' ? 'completed' : 'not_started';
    await updateTaskStatus(taskId, nextStatus);
    await updateTaskProgressStatus(taskId, mappedProgressStatus);
    showMessage('task-message', 'Task status updated.');
    await loadTasks();
  } catch (err) {
    serverTasks = previousServerTasks;
    applyTaskFilters();
    showMessage('task-message', err.message, true);
  }
}

async function updateTaskProgress(taskId, progressStatus) {
  const previousServerTasks = serverTasks.map((task) => ({ ...task }));
  serverTasks = serverTasks.map((task) => {
    if (task.id !== taskId) return task;
    return {
      ...task,
      progressStatus,
      status: progressStatus === 'completed' ? 'completed' : (task.status === 'completed' ? 'pending' : task.status)
    };
  });
  applyTaskFilters();

  try {
    await updateTaskProgressStatus(taskId, progressStatus);
    showMessage('task-message', 'Task progress updated.');
    await loadTasks();
  } catch (err) {
    serverTasks = previousServerTasks;
    applyTaskFilters();
    showMessage('task-message', err.message, true);
  }
}

async function cancelTaskByReason(taskId, reason) {
  const trimmed = String(reason || '').trim();
  if (!trimmed) {
    showMessage('task-message', 'Cancellation reason is required.', true);
    return;
  }

  try {
    await cancelTask(taskId, trimmed);
    showMessage('task-message', 'Task cancelled successfully.');
    await loadTasks();
  } catch (err) {
    showMessage('task-message', err.message, true);
  }
}

async function removeTask(taskId) {
  const previousServerTasks = serverTasks.map((task) => ({ ...task }));
  serverTasks = serverTasks.filter((task) => task.id !== taskId);
  applyTaskFilters();

  try {
    await deleteTask(taskId);
    showMessage('task-message', 'Task deleted successfully.');
  } catch (err) {
    serverTasks = previousServerTasks;
    applyTaskFilters();
    showMessage('task-message', err.message, true);
  }
}

function setupAuthPage() {
  const token = getToken();
  if (token) {
    window.location.href = 'dashboard.html';
    return;
  }

  const emailInput = document.getElementById('email');
  const passwordInput = document.getElementById('password');
  const registerBtn = document.getElementById('register-btn');
  const loginBtn = document.getElementById('login-btn');

  registerBtn.addEventListener('click', async () => {
    try {
      await register(emailInput.value.trim(), passwordInput.value);
      showMessage('auth-message', 'Registration successful. You can now log in.');
    } catch (err) {
      showMessage('auth-message', err.message, true);
    }
  });

  loginBtn.addEventListener('click', async () => {
    try {
      const result = await login(emailInput.value.trim(), passwordInput.value);
      setToken(result.token);
      showMessage('auth-message', 'Login successful. Redirecting...');
      window.location.href = 'dashboard.html';
    } catch (err) {
      showMessage('auth-message', err.message, true);
    }
  });
}

function setupDashboardPage() {
  const token = getToken();
  if (!token) {
    window.location.href = 'index.html';
    return;
  }

  const taskForm = document.getElementById('task-form');
  const logoutBtn = document.getElementById('logout-btn');
  const refreshBtn = document.getElementById('refresh-btn');
  const filterSelect = document.getElementById('task-filter');
  const searchInput = document.getElementById('task-search');
  const fromDateInput = document.getElementById('from-date');
  const toDateInput = document.getElementById('to-date');
  const applyDateFilterBtn = document.getElementById('apply-date-filter-btn');
  const visibilitySelect = document.getElementById('visibility');

  if (filterSelect) {
    currentFilter = filterSelect.value || 'visible';
  }

  if (searchInput) {
    currentSearchTerm = searchInput.value || '';
  }

  if (fromDateInput) currentFromDate = fromDateInput.value || '';
  if (toDateInput) currentToDate = toDateInput.value || '';

  taskForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const title = document.getElementById('title').value.trim();
    const description = document.getElementById('description').value.trim();

    try {
      await createTask(title, description);
      showMessage('task-message', 'Task created successfully.');
      taskForm.reset();
      toggleSelectedUsersInput();
      await loadTasks();
    } catch (err) {
      showMessage('task-message', err.message, true);
    }
  });

  logoutBtn.addEventListener('click', () => {
    clearToken();
    window.location.href = 'index.html';
  });

  refreshBtn.addEventListener('click', async () => {
    try {
      await loadTasks();
      showMessage('task-message', 'Task list refreshed.');
    } catch (err) {
      showMessage('task-message', err.message, true);
    }
  });

  if (filterSelect) {
    filterSelect.addEventListener('change', async (event) => {
      currentFilter = event.target.value;
      try {
        await loadTasks();
        showMessage('task-message', 'Task list filtered.');
      } catch (err) {
        showMessage('task-message', err.message, true);
      }
    });
  }

  if (searchInput) {
    searchInput.addEventListener('input', (event) => {
      currentSearchTerm = event.target.value || '';
      applyTaskFilters();
    });
  }

  if (applyDateFilterBtn) {
    applyDateFilterBtn.addEventListener('click', async () => {
      currentFromDate = fromDateInput?.value || '';
      currentToDate = toDateInput?.value || '';
      try {
        await loadTasks();
        showMessage('task-message', 'Date filter applied.');
      } catch (err) {
        showMessage('task-message', err.message, true);
      }
    });
  }

  if (visibilitySelect) {
    visibilitySelect.addEventListener('change', () => {
      toggleSelectedUsersInput();
    });
  }

  fetchUsers()
    .then((users) => {
      availableUsers = users;
      populateAllowedUsers(availableUsers);
      toggleSelectedUsersInput();
    })
    .catch((err) => {
      showMessage('task-message', err.message, true);
    });

  loadTasks().catch((err) => {
    showMessage('task-message', err.message, true);
  });
}

document.addEventListener('DOMContentLoaded', () => {
  const page = document.body.dataset.page;
  if (page === 'auth') {
    setupAuthPage();
  } else if (page === 'dashboard') {
    setupDashboardPage();
  }
});
