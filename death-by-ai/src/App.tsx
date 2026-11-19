import { usePath } from './lib/route.ts'
import { HostGame } from './screens/HostGame.tsx'
import { HostHome } from './screens/HostHome.tsx'
import { Join } from './screens/Join.tsx'
import { PlayerGame } from './screens/PlayerGame.tsx'

export function App() {
  const path = usePath()

  const host = path.match(/^\/host\/(\d{6})\/?$/)
  if (host) return <HostGame key={host[1]} code={host[1]} />
  if (/^\/host\/?$/.test(path)) return <HostHome />

  const play = path.match(/^\/play\/(\d{6})\/?$/)
  if (play) return <PlayerGame key={play[1]} code={play[1]} />

  const join = path.match(/^\/join\/(\d{6})\/?$/)
  return <Join key={join?.[1] ?? ''} initialCode={join?.[1] ?? ''} />
}
