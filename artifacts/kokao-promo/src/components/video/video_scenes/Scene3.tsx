import { motion } from 'framer-motion';
import { useState, useEffect } from 'react';

export function Scene3() {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const timers = [
      setTimeout(() => setPhase(1), 100),
      setTimeout(() => setPhase(2), 600),
      setTimeout(() => setPhase(3), 2000),
    ];
    return () => timers.forEach(t => clearTimeout(t));
  }, []);

  return (
    <motion.div 
      className="absolute inset-0 flex flex-col items-center justify-center"
      initial={{ opacity: 0, y: 50 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ scale: 1.5, opacity: 0, filter: 'blur(10px)' }}
      transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
    >
      {/* Background radial highlight */}
      <motion.div 
        className="absolute w-[100vw] h-[100vw] bg-accent/10 rounded-full blur-[100px]"
        initial={{ scale: 0 }}
        animate={phase >= 1 ? { scale: 1 } : { scale: 0 }}
        transition={{ duration: 1.5, ease: "easeOut" }}
      />

      <div className="relative z-10 text-center w-full px-[10vw]">
        <motion.h2 
          className="text-[5.5vw] font-display font-bold leading-tight"
        >
          <motion.span 
            className="block text-white"
            initial={{ opacity: 0, y: 40, rotateX: 45 }}
            animate={phase >= 1 ? { opacity: 1, y: 0, rotateX: 0 } : { opacity: 0, y: 40, rotateX: 45 }}
            transition={{ type: "spring", stiffness: 300, damping: 25 }}
          >
            Multi-Tenant SaaS.
          </motion.span>
          <motion.span 
            className="block text-gradient mt-[1vh]"
            initial={{ opacity: 0, y: 40, rotateX: 45 }}
            animate={phase >= 2 ? { opacity: 1, y: 0, rotateX: 0 } : { opacity: 0, y: 40, rotateX: 45 }}
            transition={{ type: "spring", stiffness: 300, damping: 25 }}
          >
            AI-Powered Content.
          </motion.span>
        </motion.h2>
      </div>
    </motion.div>
  );
}
