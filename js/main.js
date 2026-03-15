document.addEventListener('DOMContentLoaded', () => {

    // ===== Navbar scroll effect =====
    const navbar = document.getElementById('navbar');
    const navLinks = document.querySelectorAll('.nav-link');
    const sections = document.querySelectorAll('section[id]');

    function handleNavScroll() {
        if (window.scrollY > 50) {
            navbar.classList.add('scrolled');
        } else {
            navbar.classList.remove('scrolled');
        }
    }

    function updateActiveNav() {
        const scrollPos = window.scrollY + 200;

        sections.forEach(section => {
            const top = section.offsetTop;
            const height = section.offsetHeight;
            const id = section.getAttribute('id');

            if (scrollPos >= top && scrollPos < top + height) {
                navLinks.forEach(link => {
                    link.classList.remove('active');
                    if (link.getAttribute('href') === `#${id}`) {
                        link.classList.add('active');
                    }
                });
            }
        });
    }

    window.addEventListener('scroll', () => {
        handleNavScroll();
        updateActiveNav();
    }, { passive: true });

    // ===== Set data-text on nav-text spans for glitch effect =====
    document.querySelectorAll('.nav-text').forEach(span => {
        span.setAttribute('data-text', span.textContent);
    });

    // ===== Mobile nav toggle =====
    const navToggle = document.getElementById('navToggle');
    const navMenu = document.getElementById('navMenu');

    navToggle.addEventListener('click', () => {
        navToggle.classList.toggle('active');
        navMenu.classList.toggle('open');
    });

    navLinks.forEach(link => {
        link.addEventListener('click', () => {
            navToggle.classList.remove('active');
            navMenu.classList.remove('open');
        });
    });

    // ===== Dropdown project cards also navigate =====
    document.querySelectorAll('.dropdown-project-card').forEach(card => {
        card.addEventListener('click', (e) => {
            e.preventDefault();
            const target = document.querySelector('#projects');
            if (target) target.scrollIntoView({ behavior: 'smooth' });
        });
    });

    // ===== Smooth scroll for anchor links =====
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', (e) => {
            e.preventDefault();
            const target = document.querySelector(anchor.getAttribute('href'));
            if (target) {
                target.scrollIntoView({ behavior: 'smooth' });
            }
        });
    });

    // ===== Scroll animations (Intersection Observer) =====
    const animatedElements = document.querySelectorAll('[data-animate]');

    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                const delay = entry.target.getAttribute('data-delay') || 0;
                setTimeout(() => {
                    entry.target.classList.add('visible');
                }, parseInt(delay));
                observer.unobserve(entry.target);
            }
        });
    }, {
        threshold: 0.1,
        rootMargin: '0px 0px -50px 0px'
    });

    animatedElements.forEach(el => observer.observe(el));

    // ===== Counter animation =====
    const counters = document.querySelectorAll('[data-count]');

    const counterObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                const el = entry.target;
                const target = parseInt(el.getAttribute('data-count'));
                animateCounter(el, target);
                counterObserver.unobserve(el);
            }
        });
    }, { threshold: 0.5 });

    counters.forEach(counter => counterObserver.observe(counter));

    function animateCounter(el, target) {
        const duration = 1500;
        const start = performance.now();

        function update(now) {
            const elapsed = now - start;
            const progress = Math.min(elapsed / duration, 1);
            const eased = 1 - Math.pow(1 - progress, 4);
            el.textContent = Math.round(eased * target);

            if (progress < 1) {
                requestAnimationFrame(update);
            }
        }

        requestAnimationFrame(update);
    }

    // ===== Contact form =====
    const contactForm = document.getElementById('contactForm');

    contactForm.addEventListener('submit', (e) => {
        e.preventDefault();

        const btn = contactForm.querySelector('button[type="submit"]');
        const originalHTML = btn.innerHTML;

        btn.innerHTML = `
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="spin">
                <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
            </svg>
            Gönderiliyor...
        `;
        btn.disabled = true;

        setTimeout(() => {
            btn.innerHTML = `
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="20 6 9 17 4 12"/>
                </svg>
                Mesaj Gönderildi!
            `;
            btn.style.background = 'linear-gradient(135deg, #22c55e, #4ade80)';
            btn.style.boxShadow = '0 4px 20px rgba(34, 197, 94, 0.3)';

            setTimeout(() => {
                btn.innerHTML = originalHTML;
                btn.disabled = false;
                btn.style.background = '';
                btn.style.boxShadow = '';
                contactForm.reset();
            }, 3000);
        }, 1500);
    });

    // ===== Tech items hover glow =====
    document.querySelectorAll('.tech-item').forEach(item => {
        item.addEventListener('mouseenter', () => {
            const icon = item.querySelector('.tech-icon');
            if (icon) {
                const color = window.getComputedStyle(icon).color;
                item.style.boxShadow = `0 8px 32px ${color}20`;
            }
        });

        item.addEventListener('mouseleave', () => {
            item.style.boxShadow = '';
        });
    });

    // ===== Particle Canvas Network =====
    const canvas = document.getElementById('particleCanvas');
    if (canvas) {
        const ctx = canvas.getContext('2d');
        let particles = [];
        let mouseX = 0, mouseY = 0;

        function resizeCanvas() {
            canvas.width = canvas.offsetWidth;
            canvas.height = canvas.offsetHeight;
        }
        resizeCanvas();
        window.addEventListener('resize', resizeCanvas);

        class Particle {
            constructor() {
                this.reset();
            }
            reset() {
                this.x = Math.random() * canvas.width;
                this.y = Math.random() * canvas.height;
                this.vx = (Math.random() - 0.5) * 0.4;
                this.vy = (Math.random() - 0.5) * 0.4;
                this.radius = Math.random() * 1.5 + 0.5;
                this.opacity = Math.random() * 0.5 + 0.1;
            }
            update() {
                this.x += this.vx;
                this.y += this.vy;
                if (this.x < 0 || this.x > canvas.width) this.vx *= -1;
                if (this.y < 0 || this.y > canvas.height) this.vy *= -1;

                const dx = mouseX - this.x;
                const dy = mouseY - this.y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                if (dist < 150) {
                    this.x -= dx * 0.005;
                    this.y -= dy * 0.005;
                }
            }
            draw() {
                ctx.beginPath();
                ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
                ctx.fillStyle = `rgba(229, 34, 40, ${this.opacity})`;
                ctx.fill();
            }
        }

        const count = Math.min(80, Math.floor(canvas.width * canvas.height / 15000));
        for (let i = 0; i < count; i++) {
            particles.push(new Particle());
        }

        function drawConnections() {
            for (let i = 0; i < particles.length; i++) {
                for (let j = i + 1; j < particles.length; j++) {
                    const dx = particles[i].x - particles[j].x;
                    const dy = particles[i].y - particles[j].y;
                    const dist = Math.sqrt(dx * dx + dy * dy);
                    if (dist < 120) {
                        const opacity = (1 - dist / 120) * 0.15;
                        ctx.beginPath();
                        ctx.moveTo(particles[i].x, particles[i].y);
                        ctx.lineTo(particles[j].x, particles[j].y);
                        ctx.strokeStyle = `rgba(229, 34, 40, ${opacity})`;
                        ctx.lineWidth = 0.5;
                        ctx.stroke();
                    }
                }
            }
        }

        function animateParticles() {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            particles.forEach(p => { p.update(); p.draw(); });
            drawConnections();
            requestAnimationFrame(animateParticles);
        }
        animateParticles();

        canvas.closest('.hero').addEventListener('mousemove', (e) => {
            const rect = canvas.getBoundingClientRect();
            mouseX = e.clientX - rect.left;
            mouseY = e.clientY - rect.top;
        }, { passive: true });
    }

    // ===== Typing effect for hero badge =====
    const typingEl = document.getElementById('typingBadge');
    if (typingEl) {
        const phrases = [
            '> Dijital Dönüşümde Öncü',
            '> Full-Stack Geliştirme',
            '> Cloud & Serverless',
            '> React / Next.js / Supabase',
            '> Ölçeklenebilir Mimari'
        ];
        let phraseIdx = 0, charIdx = 0, isDeleting = false;

        function typeLoop() {
            const current = phrases[phraseIdx];
            if (!isDeleting) {
                typingEl.textContent = current.slice(0, charIdx + 1);
                charIdx++;
                if (charIdx === current.length) {
                    setTimeout(() => { isDeleting = true; typeLoop(); }, 2500);
                    return;
                }
                setTimeout(typeLoop, 50 + Math.random() * 30);
            } else {
                typingEl.textContent = current.slice(0, charIdx);
                charIdx--;
                if (charIdx === 0) {
                    isDeleting = false;
                    phraseIdx = (phraseIdx + 1) % phrases.length;
                    setTimeout(typeLoop, 400);
                    return;
                }
                setTimeout(typeLoop, 25);
            }
        }
        setTimeout(typeLoop, 800);
    }

    // ===== Matrix Rain Canvas =====
    const matrixCanvas = document.getElementById('matrixCanvas');
    if (matrixCanvas) {
        const mCtx = matrixCanvas.getContext('2d');
        let columns, drops;
        const chars = 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン01{}[]<>/=;:.()=>import export const let function return async await';
        const charArr = chars.split('');
        const fontSize = 13;

        function initMatrix() {
            matrixCanvas.width = matrixCanvas.offsetWidth;
            matrixCanvas.height = matrixCanvas.offsetHeight;
            columns = Math.floor(matrixCanvas.width / fontSize);
            drops = Array.from({ length: columns }, () => Math.random() * -100);
        }

        initMatrix();
        window.addEventListener('resize', initMatrix);

        let matrixRunning = false;
        let matrixRAF;

        function drawMatrix() {
            mCtx.fillStyle = 'rgba(10, 10, 15, 0.06)';
            mCtx.fillRect(0, 0, matrixCanvas.width, matrixCanvas.height);

            for (let i = 0; i < drops.length; i++) {
                const char = charArr[Math.floor(Math.random() * charArr.length)];
                const x = i * fontSize;
                const y = drops[i] * fontSize;

                const brightness = Math.random();
                if (brightness > 0.95) {
                    mCtx.fillStyle = 'rgba(229, 34, 40, 0.9)';
                    mCtx.font = `bold ${fontSize}px 'JetBrains Mono', monospace`;
                } else {
                    mCtx.fillStyle = `rgba(229, 34, 40, ${0.15 + brightness * 0.2})`;
                    mCtx.font = `${fontSize}px 'JetBrains Mono', monospace`;
                }

                mCtx.fillText(char, x, y);

                if (y > matrixCanvas.height && Math.random() > 0.98) {
                    drops[i] = 0;
                }
                drops[i] += 0.4 + Math.random() * 0.3;
            }

            matrixRAF = requestAnimationFrame(drawMatrix);
        }

        const matrixObserver = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting && !matrixRunning) {
                    matrixRunning = true;
                    drawMatrix();
                } else if (!entry.isIntersecting && matrixRunning) {
                    matrixRunning = false;
                    cancelAnimationFrame(matrixRAF);
                }
            });
        }, { threshold: 0.1 });
        matrixObserver.observe(matrixCanvas.closest('.about'));
    }

    // ===== Stat cards bar animation =====
    const statCards = document.querySelectorAll('.stat-card');
    const statObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('animated');
                statObserver.unobserve(entry.target);
            }
        });
    }, { threshold: 0.5 });
    statCards.forEach(card => statObserver.observe(card));

    // ===== Parallax on hero glow =====
    const heroGlows = document.querySelectorAll('.hero-glow');

    window.addEventListener('mousemove', (e) => {
        const x = (e.clientX / window.innerWidth - 0.5) * 20;
        const y = (e.clientY / window.innerHeight - 0.5) * 20;

        heroGlows.forEach((glow, i) => {
            const factor = i === 0 ? 1 : i === 1 ? -0.7 : 0.5;
            glow.style.transform = `translate(${x * factor}px, ${y * factor}px)`;
        });
    }, { passive: true });

    // ===== CSS spin animation (for loading) =====
    const style = document.createElement('style');
    style.textContent = `
        @keyframes spin {
            to { transform: rotate(360deg); }
        }
        .spin {
            animation: spin 1s linear infinite;
        }
    `;
    document.head.appendChild(style);

    handleNavScroll();
});
