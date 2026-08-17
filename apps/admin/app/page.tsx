import { notFound } from "next/navigation";

/** Unreachable — proxy.ts 404s "/" before routing. Exists so the app builds. */
export default function Home() {
  notFound();
}
