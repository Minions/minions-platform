<template>
  <div class="district-detail">
    <h3>{{ wing.name }}</h3>

    <div class="section">
      <h4>Root</h4>
      <code>{{ wing.root }}</code>
    </div>

    <div class="section">
      <h4>Work Directories</h4>
      <div class="path-list">
        <div class="path-item">
          <span class="label">local:</span>
          <code>{{ wing.workLocal }}</code>
          <div v-if="wing.worktreeGitInfo?.workLocal" class="git-info">
            <div class="git-detail">
              <span class="git-label">Bare Repo:</span>
              <code class="git-value">{{ wing.worktreeGitInfo.workLocal.bareRepoDir || 'N/A' }}</code>
            </div>
            <div class="git-detail">
              <span class="git-label">Origin:</span>
              <code class="git-value">{{ wing.worktreeGitInfo.workLocal.origin || 'N/A' }}</code>
            </div>
          </div>
        </div>
        <div v-if="wing.workGlobal" class="path-item">
          <span class="label">global:</span>
          <code>{{ wing.workGlobal }}</code>
          <div v-if="wing.worktreeGitInfo?.workGlobal" class="git-info">
            <div class="git-detail">
              <span class="git-label">Bare Repo:</span>
              <code class="git-value">{{ wing.worktreeGitInfo.workGlobal.bareRepoDir || 'N/A' }}</code>
            </div>
            <div class="git-detail">
              <span class="git-label">Origin:</span>
              <code class="git-value">{{ wing.worktreeGitInfo.workGlobal.origin || 'N/A' }}</code>
            </div>
          </div>
        </div>
        <div v-for="entry in wing.extraWork" :key="entry.name" class="path-item">
          <span class="label">{{ entry.name }}:</span>
          <code>{{ entry.path }}</code>
          <div v-if="entry.gitInfo" class="git-info">
            <div class="git-detail">
              <span class="git-label">Bare Repo:</span>
              <code class="git-value">{{ entry.gitInfo.bareRepoDir || 'N/A' }}</code>
            </div>
            <div class="git-detail">
              <span class="git-label">Origin:</span>
              <code class="git-value">{{ entry.gitInfo.origin || 'N/A' }}</code>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="section">
      <h4>Private Directories</h4>
      <div class="path-list">
        <div class="path-item">
          <span class="label">Local:</span>
          <code>{{ wing.privateLocal }}</code>
          <div v-if="wing.worktreeGitInfo?.privateLocal" class="git-info">
            <div class="git-detail">
              <span class="git-label">Bare Repo:</span>
              <code class="git-value">{{ wing.worktreeGitInfo.privateLocal.bareRepoDir || 'N/A' }}</code>
            </div>
            <div class="git-detail">
              <span class="git-label">Origin:</span>
              <code class="git-value">{{ wing.worktreeGitInfo.privateLocal.origin || 'N/A' }}</code>
            </div>
          </div>
        </div>
        <div v-if="wing.privateGlobal" class="path-item">
          <span class="label">Global:</span>
          <code>{{ wing.privateGlobal }}</code>
          <div v-if="wing.worktreeGitInfo?.privateGlobal" class="git-info">
            <div class="git-detail">
              <span class="git-label">Bare Repo:</span>
              <code class="git-value">{{ wing.worktreeGitInfo.privateGlobal.bareRepoDir || 'N/A' }}</code>
            </div>
            <div class="git-detail">
              <span class="git-label">Origin:</span>
              <code class="git-value">{{ wing.worktreeGitInfo.privateGlobal.origin || 'N/A' }}</code>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div v-if="wing.info" class="section">
      <h4>Info Directory</h4>
      <code>{{ wing.info }}</code>
      <div v-if="wing.infoRepos && wing.infoRepos.length > 0" class="info-repos">
        <h5>Git Repositories:</h5>
        <div class="repo-list">
          <div v-for="repo in wing.infoRepos" :key="repo.name" class="repo-item">
            <div class="repo-name">{{ repo.name }}</div>
            <div class="repo-origin">
              <span class="git-label">Origin:</span>
              <code class="git-value">{{ repo.origin || 'N/A' }}</code>
            </div>
          </div>
        </div>
      </div>
      <span v-else class="note">(No git repositories found)</span>
    </div>

  </div>
</template>

<script setup lang="ts">
import type { Wing } from '../types/wing';

defineProps<{
  wing: Wing;
}>();
</script>

<style scoped>
.wing-detail {
  padding: 16px;
}

.section {
  margin: 16px 0;
}

.section h4 {
  margin: 0 0 8px 0;
  color: #555;
  font-size: 0.9em;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.path-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.path-item {
  display: flex;
  gap: 8px;
  align-items: baseline;
}

.label {
  font-weight: 600;
  min-width: 60px;
}

code {
  background-color: #f5f5f5;
  padding: 4px 8px;
  border-radius: 4px;
  font-family: 'Courier New', monospace;
  font-size: 0.9em;
  color: #333;
}

.git-info {
  margin-top: 8px;
  margin-left: 68px;
  padding: 8px;
  background: #f9f9f9;
  border-left: 3px solid #1976d2;
  border-radius: 4px;
}

.git-detail {
  display: flex;
  gap: 8px;
  margin-bottom: 4px;
  align-items: baseline;
}

.git-detail:last-child {
  margin-bottom: 0;
}

.git-label {
  font-size: 11px;
  font-weight: 600;
  color: #666;
  min-width: 70px;
}

.git-value {
  font-size: 11px;
  padding: 2px 6px;
}

.info-repos {
  margin-top: 12px;
}

.info-repos h5 {
  margin: 8px 0 8px 0;
  font-size: 0.85em;
  color: #666;
  font-weight: 600;
}

.repo-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.repo-item {
  padding: 8px;
  background: #f9f9f9;
  border-left: 3px solid #4caf50;
  border-radius: 4px;
}

.repo-name {
  font-weight: 600;
  color: #333;
  margin-bottom: 4px;
}

.repo-origin {
  display: flex;
  gap: 8px;
  align-items: baseline;
  font-size: 12px;
}

.note {
  margin-left: 8px;
  color: #666;
  font-size: 12px;
  font-style: italic;
}
</style>
