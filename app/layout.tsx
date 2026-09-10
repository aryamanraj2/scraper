import type { ReactNode } from 'react'
import './globals.css'
import { MILESTONE_STAGE } from '../src/core/config/stage.js'

export const metadata = {
  title: 'Internship Outreach Intelligence',
  description: 'Review-first application funnel. The system prepares; you submit.',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="wrap">
          <header className="top">
            <h1>
              <a href="/">Internship Outreach Intelligence</a>
            </h1>
            <p>
              Stage {MILESTONE_STAGE} · the system prepares applications; you submit them. Sending is
              hard-disabled until F5.
            </p>
          </header>
          {children}
        </div>
      </body>
    </html>
  )
}
