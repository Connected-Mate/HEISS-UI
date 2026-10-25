export const springs = {
  fast: {
    type: "spring" as const,
    duration: 0.08,
    bounce: 0,
  },
  moderate: {
    type: "spring" as const,
    duration: 0.16,
    bounce: 0.15,
  },
  slow: {
    type: "spring" as const,
    duration: 0.24,
    bounce: 0.15,
  },
} as const;

/**
 * Overlay motion, mirroring --motion-* in 00-tokens.css and the surfaceIn /
 * surfaceOut keyframes in 09-motion.css, so a framer-driven popover opens and
 * closes exactly like a CSS-driven menu or a Modal.
 */
const motionEase = [0.16, 1, 0.3, 1] as const;
const motionEaseIn = [0.4, 0, 1, 1] as const;
export const surfaceMotion = {
  initial: { opacity: 0, y: 6, scale: 0.98 },
  animate: { opacity: 1, y: 0, scale: 1 },
  exit: { opacity: 0, y: 6, scale: 0.98, transition: { duration: 0.14, ease: motionEaseIn } },
  transition: { duration: 0.2, ease: motionEase },
} as const;
