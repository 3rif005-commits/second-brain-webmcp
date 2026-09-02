"use client";

import { createContext, useContext, useState } from "react";

interface AIThreadContextValue {
  activeThreadId: string | null;
  setActiveThreadId: (id: string | null) => void;
}

const AIThreadContext = createContext<AIThreadContextValue>({
  activeThreadId: null,
  setActiveThreadId: () => {},
});

export function AIThreadProvider({ children }: { children: React.ReactNode }) {
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  return (
    <AIThreadContext.Provider value={{ activeThreadId, setActiveThreadId }}>
      {children}
    </AIThreadContext.Provider>
  );
}

export function useAIThread() {
  return useContext(AIThreadContext);
}
