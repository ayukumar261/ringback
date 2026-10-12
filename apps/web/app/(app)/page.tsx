import { LockKeyhole, PhoneCall } from "lucide-react"

export default function Page() {
  return (
    <main className="mx-auto flex min-h-svh max-w-lg flex-col justify-center gap-6 px-6 py-16">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <PhoneCall className="size-4 text-primary" /> ringback
      </div>
      <LockKeyhole className="size-8 text-muted-foreground" />
      <h1 className="text-3xl font-semibold tracking-tight">
        Every call has its own private space.
      </h1>
      <p className="text-base leading-relaxed text-muted-foreground">
        Open the private call link provided when your call was requested. You
        can follow its progress, read the conversation, and listen to the
        recording here.
      </p>
    </main>
  )
}
