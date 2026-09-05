import NextAuth from "next-auth";
import { humanAuthOptions } from "@/lib/admin-auth";

const handler = NextAuth(humanAuthOptions);

export { handler as GET, handler as POST };
