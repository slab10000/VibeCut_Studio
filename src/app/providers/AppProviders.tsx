import { PropsWithChildren, useState } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createQueryClient } from "@/shared/query/client";

export default function AppProviders({ children }: PropsWithChildren) {
  const [queryClient] = useState(() => createQueryClient());
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
