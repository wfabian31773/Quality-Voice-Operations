import { useScrollReveal } from '../hooks/useScrollReveal';

export default function RevealSection({
  children,
  className = '',
  delay = '',
}: {
  children: React.ReactNode;
  className?: string;
  delay?: string;
}) {
  const ref = useScrollReveal();
  return (
    <div ref={ref} className={`scroll-reveal ${delay} ${className}`}>
      {children}
    </div>
  );
}
