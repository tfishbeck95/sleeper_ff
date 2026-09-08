import type { ButtonHTMLAttributes, PropsWithChildren, ReactNode } from 'react';
export function Button({ className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement>) { return <button className={`button ${className}`} {...props} />; }
export function Card({ children, className = '' }: PropsWithChildren<{ className?: string }>) { return <section className={`card ${className}`}>{children}</section>; }
export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'positive' | 'warning' | 'neutral' }) { return <span className={`badge badge--${tone}`}>{children}</span>; }
