// One running counter, bumped by every PR that changes behaviour (the same rule as
// vinyl-command's api/worker and the iOS app). The page shows it in its footer, and
// every response carries it as X-Crates-Version.
export const VERSION = "1.2";
