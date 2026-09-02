import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { BrainLayoutClient } from "@/components/sidebar/BrainLayoutClient";
import { AgentPanel } from "@/components/webmcp/AgentPanel";

export default async function BrainLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  if (
    !process.env.NEXT_PUBLIC_SUPABASE_URL ||
    !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  ) {
    redirect("/login");
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  return (
    <BrainLayoutClient>
      {children}
      {/* WebMCP tool surface, visible. Renders as a collapsed pill until
          opened, so it costs nothing until someone wants to look. */}
      <AgentPanel />
    </BrainLayoutClient>
  );
}
