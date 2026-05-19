import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** shadcn's class-name helper. Combines clsx + tailwind-merge so conflicting
 * Tailwind classes resolve sensibly (the LAST class wins, not the first). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
