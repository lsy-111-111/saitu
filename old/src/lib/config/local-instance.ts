/** Only this independent copy's loopback database may use its separate port. */
export function isStandaloneDatabase(url: URL): boolean {
  if (!["postgres:", "postgresql:"].includes(url.protocol) || url.hostname !== "127.0.0.1"
    || url.port !== "5433" || url.search || url.hash) return false;
  const name = decodeURIComponent(url.pathname.slice(1));
  if (process.env.SAITU_STANDALONE_LOCAL === "1" && name === "saitu_clean") return true;
  return process.env.NODE_ENV === "test" && process.env.SAITU_LOCAL_TEST_DATABASE === "1"
    && /^(?:resume_ai_test_[a-f0-9]{16}|saitu_v7_(?:backend|durable)_[a-f0-9]{32}|saitu_clean_test_[a-f0-9]{16})$/.test(name);
}
