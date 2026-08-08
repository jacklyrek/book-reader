import type { JSX } from 'preact'
import {
  cancelJob,
  clearFinishedJobs,
  downloadQueue,
  pauseAll,
  resumeAll,
  runQueue,
} from '../core/downloads'
import { listLibrary } from '../core/library'
import { formatBytes } from '../core/storage'
import { useAsync, useStore } from '../core/store'
import type { DownloadJob } from '../core/types'
import { Empty, ProgressBar } from './components'

export function Downloads(): JSX.Element {
  const jobs = useStore(downloadQueue)
  const { data: books } = useAsync(listLibrary, [])
  const titles = new Map((books ?? []).map((b) => [b.bookId, b.title]))

  if (jobs.length === 0) {
    return <Empty title="Nothing queued" body="Downloads you start will show up here." />
  }

  // Children are rendered under their parent; top level is parents + singletons.
  const top = jobs.filter((job) => !job.parentId)
  const active = jobs.some((job) => job.state === 'running' || job.state === 'queued')

  return (
    <div class="downloads">
      <div class="downloads-controls">
        {active ? (
          <button type="button" class="button button-small" onClick={() => void pauseAll()}>
            Pause all
          </button>
        ) : (
          <button type="button" class="button button-small" onClick={() => void resumeAll()}>
            Resume all
          </button>
        )}
        <button type="button" class="button button-small button-quiet" onClick={() => void runQueue()}>
          Retry now
        </button>
        <button
          type="button"
          class="button button-small button-quiet"
          onClick={() => void clearFinishedJobs()}
        >
          Clear finished
        </button>
      </div>

      <p class="note">
        One transfer runs at a time — iOS gets unhappy with several large concurrent fetches. A
        failed transfer resumes from where it stopped rather than starting over.
      </p>

      <ul class="job-list">
        {top.map((job) => (
          <JobRow
            key={job.jobId}
            job={job}
            title={titles.get(job.bookId) ?? job.bookId}
            children={jobs.filter((child) => child.parentId === job.jobId)}
          />
        ))}
      </ul>
    </div>
  )
}

function JobRow({
  job,
  title,
  children,
}: {
  job: DownloadJob
  title: string
  children: DownloadJob[]
}): JSX.Element {
  const fraction =
    job.bytesTotal > 0 ? Math.min(1, job.bytesDone / job.bytesTotal) : job.state === 'done' ? 1 : 0
  const doneCount = children.filter((c) => c.state === 'done').length

  return (
    <li class="job-row">
      <div class="job-head">
        <span class="job-title">{title}</span>
        <span class={`job-state job-state-${job.state}`}>{job.state}</span>
      </div>
      <ProgressBar value={fraction} label={`${title} download`} />
      <div class="job-meta">
        <span>
          {formatBytes(job.bytesDone)} of {formatBytes(job.bytesTotal)}
          {children.length > 0 ? ` · ${doneCount}/${children.length} sections` : ''}
        </span>
        <button type="button" class="link-button" onClick={() => void cancelJob(job.jobId)}>
          Cancel
        </button>
      </div>
      {job.error && job.state === 'error' ? <div class="job-error">{job.error}</div> : null}
    </li>
  )
}
