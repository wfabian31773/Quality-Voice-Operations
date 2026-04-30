// Page chrome primitives
export { default as PageHeader, type PageHeaderProps } from './PageHeader';
export { default as PageSection, type PageSectionProps, type PageSectionTone, type PageSectionPad, type PageSectionWidth } from './PageSection';
export { default as SectionHeader, type SectionHeaderProps } from './SectionHeader';
export { default as Hero, type HeroProps, type HeroTone, type HeroAlign } from './Hero';

// Surface primitives
export { default as SectionCard, type SectionCardProps } from './SectionCard';
export { default as ContentCard, type ContentCardProps, type ContentCardTone, type ContentCardPad } from './ContentCard';

// Composite blocks
export { default as FeatureGrid, type FeatureGridProps, type FeatureItem } from './FeatureGrid';
export { default as CTABand, type CTABandProps, type CTABandTone } from './CTABand';
export { default as StatStrip, type StatStripProps, type StatStripItem } from './StatStrip';
export { default as TestimonialBlock, type TestimonialBlockProps } from './TestimonialBlock';
export { default as Callout, type CalloutProps, type CalloutTone } from './Callout';

// Stat / status primitives
export { default as StatCard, type StatCardProps, type StatTone } from './StatCard';
export { default as StatusBadge, type StatusBadgeProps, type BadgeTone } from './StatusBadge';
export { default as StatusDot, type StatusDotProps, type DotSize } from './StatusDot';
export { default as Badge, type BadgeProps, type BadgeVariant, type BadgeSize } from './Badge';

// Motion primitives
export { default as Reveal, type RevealProps } from './Reveal';
export { default as Stagger, type StaggerProps } from './Stagger';
export { useReveal } from '../../hooks/useReveal';
export { useStagger } from '../../hooks/useStagger';
export { useParallax } from '../../hooks/useParallax';

// Re-exports for state primitives (kept here for the single import surface).
export { EmptyState, ErrorState, PageSkeleton, Skeleton, SkeletonRows, SkeletonGrid } from '../state';
export type { EmptyStateProps, ErrorStateProps } from '../state';
