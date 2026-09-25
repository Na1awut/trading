import { Redirect, useLocalSearchParams } from 'expo-router';

/** Phase 1 route kept for old links and notifications; the canonical path is /signals/events/:id. */
export default function LegacyEventRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <Redirect href={`/signals/events/${encodeURIComponent(id ?? '')}`} />;
}
