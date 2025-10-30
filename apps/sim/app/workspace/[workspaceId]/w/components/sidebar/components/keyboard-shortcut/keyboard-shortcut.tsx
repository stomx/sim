'use client'

import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'

interface KeyboardShortcutProps {
  shortcut: string
  className?: string
}

export const KeyboardShortcut = ({ shortcut, className }: KeyboardShortcutProps) => {
  const [mounted, setMounted] = useState(false)
  
  // Only render the shortcut after mounting to avoid hydration mismatch
  useEffect(() => {
    setMounted(true)
  }, [])

  const parts = shortcut.split('+')

  // Helper function to determine if a part is a symbol that should be larger
  const isSymbol = (part: string) => {
    return ['⌘', '⇧', '⌥', '⌃'].includes(part)
  }

  // Show a placeholder during SSR to avoid hydration mismatch
  if (!mounted) {
    return (
      <kbd
        className={cn(
          'flex h-6 w-8 items-center justify-center rounded-[5px] border border-border bg-background font-mono text-[#CDCDCD] text-xs dark:text-[#454545]',
          className
        )}
      >
        <span className='flex items-center justify-center gap-[1px] pt-[1px]'>
          <span className='text-xs'>⌘K</span>
        </span>
      </kbd>
    )
  }

  return (
    <kbd
      className={cn(
        'flex h-6 w-8 items-center justify-center rounded-[5px] border border-border bg-background font-mono text-[#CDCDCD] text-xs dark:text-[#454545]',
        className
      )}
    >
      <span className='flex items-center justify-center gap-[1px] pt-[1px]'>
        {parts.map((part, index) => (
          <span key={index} className={cn(isSymbol(part) ? 'text-[17px]' : 'text-xs')}>
            {part}
          </span>
        ))}
      </span>
    </kbd>
  )
}
