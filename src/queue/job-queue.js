import crypto from 'crypto';
import { logger } from '../utils/logger.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { get } from '../utils/config.js';

const JOB_TIMEOUT = get('jobTimeoutMs', 300000);
const MAX_JOBS = 50;

/**
 * Simple single-job queue. Only one job can run at a time.
 */
class JobQueue {
  constructor() {
    this.currentJob = null;
    this.jobs = new Map();
    this.listeners = new Map();
  }

  generateId() {
    return crypto.randomUUID().slice(0, 8);
  }

  // JOB_TIMEOUT was declared here from the start and never actually used, which
  // is the whole reason the queue could wedge: a job that reached 'running' and
  // whose handler never returned — the client abandoned the request, Playwright
  // hung — stayed 'running' forever, and createJob's guard below then rejected
  // every later call until the server was restarted.
  //
  // Checked lazily rather than on a timer: nothing observes a job's expiry
  // except the two synchronous entry points below, and a live setInterval would
  // hold the Node event loop open, which a stdio server needs to be able to
  // release when its client closes the pipe.
  reapStale() {
    const j = this.currentJob;
    if (!j || (j.status !== 'running' && j.status !== 'queued')) return null;
    // startedAt is only set by startJob, so a job that threw between createJob
    // and startJob has none — fall back to createdAt or it would be immortal.
    const started = Date.parse(j.startedAt || j.createdAt);
    if (!Number.isFinite(started) || Date.now() - started < JOB_TIMEOUT) return null;
    logger.warn('Reaping stale job', { jobId: j.id, type: j.type, status: j.status, startedAt: j.startedAt });
    return this.failJob(j.id, new FlowError(
      ErrorCodes.GENERATION_TIMEOUT,
      `Job ${j.id} (${j.type}) exceeded jobTimeoutMs (${JOB_TIMEOUT}ms) without completing — auto-reaped.`
    ));
  }

  /**
   * Create a new job. Returns job ID.
   * Throws JOB_IN_PROGRESS if another job is already active.
   */
  createJob(type, params = {}) {
    this.reapStale();
    if (this.currentJob && this.currentJob.status === 'running') {
      throw new FlowError(
        ErrorCodes.JOB_IN_PROGRESS,
        `A job is already in progress: ${this.currentJob.id} (${this.currentJob.type}). Wait for it to complete.`,
        { currentJobId: this.currentJob.id }
      );
    }

    const id = this.generateId();
    const job = {
      id,
      type,
      params,
      status: 'queued',
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      result: null,
      error: null,
      progress: 0,
    };

    this.jobs.set(id, job);
    this.currentJob = job;
    logger.info('Job created', { jobId: id, type });

    return job;
  }

  startJob(id) {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Job not found: ${id}`);
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    this.emit('start', job);
    return job;
  }

  completeJob(id, result) {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Job not found: ${id}`);
    job.status = 'completed';
    job.completedAt = new Date().toISOString();
    job.result = result;
    job.progress = 100;
    this.currentJob = null;
    this.emit('complete', job);
    logger.info('Job completed', { jobId: id, type: job.type });
    this.pruneJobs();
    return job;
  }

  failJob(id, error) {
    const job = this.jobs.get(id);
    if (!job) {
      logger.error('Cannot fail unknown job', { jobId: id });
      return null;
    }
    job.status = 'failed';
    job.completedAt = new Date().toISOString();
    job.error = error instanceof Error ? { message: error.message, code: error.code, stack: error.stack } : { message: String(error) };
    this.currentJob = null;
    this.emit('failed', job);
    logger.error('Job failed', { jobId: id, type: job.type, error: job.error.message });
    this.pruneJobs();
    return job;
  }

  setManualAction(id) {
    const job = this.jobs.get(id);
    if (!job) return;
    job.status = 'manual_action_required';
    this.emit('manual', job);
  }

  updateProgress(id, progress) {
    const job = this.jobs.get(id);
    if (!job) return;
    job.progress = Math.min(100, Math.max(0, progress));
  }

  getJob(id) {
    return this.jobs.get(id);
  }

  getCurrentJob() {
    return this.currentJob;
  }

  // Escape hatch for a job that never called completeJob/failJob on some exit
  // path (a real bug elsewhere) — without this, a single-slot, in-memory
  // queue like this one stays stuck for the rest of the process's life with
  // no way to recover except restarting the whole MCP server.
  forceReset() {
    if (!this.currentJob) return null;
    const stuck = this.currentJob;
    return this.failJob(stuck.id, 'Force-reset via flow_queue_reset — job never completed or failed on its own.');
  }

  getCompletedJobs() {
    return [...this.jobs.values()].filter(j => j.status === 'completed');
  }

  // historyLimit was advertised in the tool schema and passed by the caller,
  // but this method took no arguments and returned no history at all. It does
  // now — deliberately omitting params (the full prompt, up to 1400 chars),
  // result, and stack traces, which is what made returning history a token trap
  // in the first place.
  getStatus(historyLimit = 0) {
    this.reapStale();
    const status = {
      hasActiveJob: this.currentJob?.status === 'running' || this.currentJob?.status === 'queued',
      currentJob: this.currentJob ? {
        id: this.currentJob.id,
        type: this.currentJob.type,
        status: this.currentJob.status,
        progress: this.currentJob.progress,
        createdAt: this.currentJob.createdAt,
      } : null,
      totalJobs: this.jobs.size,
    };
    if (historyLimit > 0) {
      status.history = [...this.jobs.values()]
        .filter(j => j.status === 'completed' || j.status === 'failed')
        .sort((a, b) => Date.parse(b.completedAt) - Date.parse(a.completedAt))
        .slice(0, historyLimit)
        .map(j => ({ id: j.id, type: j.type, status: j.status, completedAt: j.completedAt, error: j.error?.message }));
    }
    return status;
  }

  // this.jobs was never pruned, so every job of the process's life stayed
  // resident with its full prompt in params. The prompt now lives on disk in
  // the media index, so there is nothing to lose by capping this.
  pruneJobs() {
    if (this.jobs.size <= MAX_JOBS) return;
    const finished = [...this.jobs.values()]
      .filter(j => j.status === 'completed' || j.status === 'failed')
      .sort((a, b) => Date.parse(a.completedAt) - Date.parse(b.completedAt));
    for (const j of finished.slice(0, this.jobs.size - MAX_JOBS)) this.jobs.delete(j.id);
  }

  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event).push(callback);
  }

  emit(event, data) {
    const callbacks = this.listeners.get(event) || [];
    callbacks.forEach(cb => {
      try { cb(data); } catch (err) { logger.error('Job queue listener error', { event, error: err.message }); }
    });
  }
}

export const jobQueue = new JobQueue();
export default jobQueue;
