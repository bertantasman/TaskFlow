const API_BASE_URL = 'http://localhost:4000';
const TOKEN_KEY = 'taskflow_token';
let serverTasks = [];
let currentTasks = [];
let currentFilter = 'visible';
let currentSearchTerm = '';

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
    <li class="task-item ${isCompletedTask(task.status) ? 'is-completed' : ''}">
      <div class="task-main-row">
        <input
          class="task-check"
          type="checkbox"
          data-task-id="${task.id}"
          ${isCompletedTask(task.status) ? 'checked' : ''}
          aria-label="Task completion status"
        />
        <div class="task-content">
          <div class="task-title">${escapeHtml(task.title || 'Untitled Task')}</div>
          <p class="task-description">${escapeHtml(task.description || 'No description provided.')}</p>
          ${task.visibility === 'public' ? `<p class="task-owner">Created by: ${escapeHtml(task.createdBy || 'unknown')}</p>` : ''}
          <div class="task-meta">
            <span>Status</span>
            <span class="status-badge ${getStatusClass(task.status)}">${escapeHtml(task.status || 'pending')}</span>
            <span class="visibility-badge ${getVisibilityClass(task.visibility)}">${escapeHtml(task.visibility || 'private')}</span>
          </div>
          <div class="task-actions">
            <button
              type="button"
              class="task-delete-btn ${String(task.createdBy || '').toLowerCase() === currentUser ? '' : 'is-disabled'}"
              data-delete-id="${task.id}"
              ${String(task.createdBy || '').toLowerCase() === currentUser ? '' : 'disabled'}
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
  const { response, data } = await apiRequest(`/tasks?filter=${encodeURIComponent(currentFilter)}`, { method: 'GET' });

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
  const { response, data } = await apiRequest('/tasks', {
    method: 'POST',
    body: JSON.stringify({ title, description, visibility })
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
    await updateTaskStatus(taskId, nextStatus);
    showMessage('task-message', 'Task status updated.');
  } catch (err) {
    serverTasks = previousServerTasks;
    applyTaskFilters();
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

  if (filterSelect) {
    currentFilter = filterSelect.value || 'visible';
  }

  if (searchInput) {
    currentSearchTerm = searchInput.value || '';
  }

  taskForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const title = document.getElementById('title').value.trim();
    const description = document.getElementById('description').value.trim();

    try {
      await createTask(title, description);
      showMessage('task-message', 'Task created successfully.');
      taskForm.reset();
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
