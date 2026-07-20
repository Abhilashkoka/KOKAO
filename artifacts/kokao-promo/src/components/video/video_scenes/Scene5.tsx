import { motion } from 'framer-motion';
import { useState, useEffect } from 'react';

export function Scene5() {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const timers = [
      setTimeout(() => setPhase(1), 200),
      setTimeout(() => setPhase(2), 800),
    ];
    return () => timers.forEach(t => clearTimeout(t));
  }, []);

  const platforms = ["Instagram", "Facebook", "LinkedIn", "YouTube", "X", "Threads"];

  return (
    <motion.div 
      className="absolute inset-0 flex flex-col items-center justify-center bg-bg-dark"
      initial={{ opacity: 0, filter: 'blur(20px)' }}
      animate={{ opacity: 1, filter: 'blur(0px)' }}
      exit={{ opacity: 0, scale: 0.9 }}
      transition={{ duration: 0.8 }}
    >
      <motion.h2 
        className="text-[4vw] font-display font-bold text-white mb-[8vh] text-center"
        initial={{ opacity: 0, y: 20 }}
        animate={phase >= 1 ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
      >
        Connect everywhere.
      </motion.h2>

      <div className="flex flex-wrap justify-center gap-[2vw] max-w-[80vw]">
        {platforms.map((p, i) => (
          <motion.div
            key={p}
            className="px-[3vw] py-[2vh] bg-white/10 rounded-full border border-white/20 text-[2vw] font-bold text-white shadow-xl"
            initial={{ opacity: 0, scale: 0, y: 50 }}
            animate={phase >= 2 ? { opacity: 1, scale: 1, y: 0 } : { opacity: 0, scale: 0, y: 50 }}
            transition={{ type: "spring", stiffness: 300, damping: 20, delay: i * 0.1 }}
          >
            {p}
          </motion.div>
        ))}
      </div>
      
      {/* Central connection hub visual */}
      <motion.div 
        className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[60vw] h-[60vw] rounded-full border border-primary/20 -z-10"
        animate={{ scale: [1, 1.2, 1], opacity: [0.2, 0.5, 0.2] }}
        transition={{ duration: 3, repeat: Infinity }}
      />
    </motion.div>
  );
}
