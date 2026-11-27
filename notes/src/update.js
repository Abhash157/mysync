// Looks on GitHub for a newer MyNotes. Only runs when asked; nothing is downloaded or installed.
export const RELEASES = 'https://api.github.com/repos/Abhash157/mysync/releases?per_page=100';

// The repository also holds MySync releases; ours are tagged notes-v1.2.3.
const TAG = /^notes-v(\d+\.\d+\.\d+)$/;

const compare = (a, b) => {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
};

/** The newest release above `current` as { version, url }, or null when there is none. */
export function newer(releases, current) {
  let best = null;
  for (const r of releases) {
    const version = !r.draft && r.tag_name?.match(TAG)?.[1];
    if (version && compare(version, best?.version || current) > 0) best = { version, url: r.html_url };
  }
  return best;
}
