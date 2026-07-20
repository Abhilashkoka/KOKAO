import { motion } from 'framer-motion';
import { useState, useEffect } from 'react';

export function Scene1() {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const timers = [
      setTimeout(() => setPhase(1), 300),
      setTimeout(() => setPhase(2), 1200),
      setTimeout(() => setPhase(3), 2200),
    ];
    return () => timers.forEach(t => clearTimeout(t));
  }, []);

  return (
    <motion.div 
      className="absolute inset-0 flex items-center justify-center"
      initial={{ opacity: 0, scale: 1.1 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, filter: 'blur(20px)', scale: 1.2 }}
      transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
    >
      <div className="relative z-10 text-center">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={phase >= 1 ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
          transition={{ duration: 0.6, ease: "easeOut" }}
          className="text-text-secondary font-display text-[2vw] tracking-[0.2em] uppercase mb-4"
        >
          The Problem
        </motion.div>
        
        <motion.h1 
          className="text-[6vw] font-display font-bold leading-none tracking-tight"
        >
          <motion.span
            initial={{ opacity: 0, x: -30 }}
            animate={phase >= 2 ? { opacity: 1, x: 0 } : { opacity: 0, x: -30 }}
            transition={{ type: "spring", stiffness: 300, damping: 20 }}
            className="inline-block mr-[1vw]"
          >
            Social Media
          </motion.span>
          <br />
          <motion.span
            initial={{ opacity: 0, x: 30 }}
            animate={phase >= 2 ? { opacity: 1, x: 0 } : { opacity: 0, x: 30 }}
            transition={{ type: "spring", stiffness: 300, damping: 20, delay: 0.1 }}
            className="inline-block text-error"
          >
            is Chaos.
          </motion.span>
        </motion.h1>
      </div>

      {/* Midground chaotic elements */}
      {phase >= 1 && (
        <>
          {[...Array(6)].map((_, i) => (
            <motion.div
              key={i}
              className="absolute w-[8vw] h-[8vw] rounded-2xl bg-white/5 backdrop-blur-sm border border-white/10"
              initial={{ 
                opacity: 0, 
                x: (Math.random() - 0.5) * 80 + 'vw', 
                y: (Math.random() - 0.5) * 80 + 'vh',
                rotate: Math.random() * 90 - 45,
                scale: 0
              }}
              animate={{ 
                opacity: phase >= 2 ? 0.8 : 0, 
                y: (Math.random() - 0.5) * 100 + 'vh',
                rotate: Math.random() * 180 - 90,
                scale: 1
              }}
              transition={{ duration: 3, ease: "easeOut" }}
            />
          ))}
        </>
      )}
    </motion.div>
  );
}
