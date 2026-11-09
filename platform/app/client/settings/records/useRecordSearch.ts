import { useEffect, useState } from "react";

export function useRecordSearch() {
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);
  return { query, setQuery, search, pending: query.trim() !== search };
}
