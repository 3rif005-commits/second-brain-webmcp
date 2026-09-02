"use client";

import { useState, useEffect, useCallback } from "react";
import type { Collection } from "@/lib/types/database";

export function useCollections() {
  const [collections, setCollections] = useState<Collection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchCollections = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/collections");
      if (!res.ok) throw new Error("Failed to fetch collections");
      const data = await res.json();
      setCollections(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchCollections();
  }, [fetchCollections]);

  async function createCollection(name: string, parentId?: string): Promise<Collection> {
    const res = await fetch("/api/collections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, parent_id: parentId ?? null }),
    });
    if (!res.ok) throw new Error("Failed to create collection");
    const collection = await res.json();
    setCollections((prev) => [...prev, collection]);
    return collection;
  }

  async function deleteCollection(collectionId: string): Promise<void> {
    const res = await fetch(`/api/collections/${collectionId}`, { method: "DELETE" });
    if (!res.ok) throw new Error("Failed to delete collection");
    setCollections((prev) => prev.filter((c) => c.id !== collectionId));
  }

  return { collections, loading, error, createCollection, deleteCollection, refetch: fetchCollections };
}
