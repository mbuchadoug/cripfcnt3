// ... existing code ...

$(document).ready(function() {
    // Define serviceDetails at the top level
    const serviceDetails = {
        strategic: {
            title: "CRIPFCnt Structural Audits (SCOI)",
            content: `
                <ul>
                    <li>Quantitative assessment of contribution vs. visibility — the world’s first structural placement metric</li>
 
                </ul>
            `
        },
        community: {
            title: "CRIPFCnt Consulting",
            content: `
                <ul>
                    <li>Recalibration strategies for individuals, organizations, and institutions seeking alignment with post-grid civilization models.</li>

                </ul>
            `
        },
        leadership: {
            title: "CRIPFCnt Academy",
            content: `
                <ul>
                    <li>Courses, frameworks, and leadership programs teaching placement-based intelligence.</li>
                    
                </ul>
            `
        },
        proposal: {
            title: "CRIPFCnt Publications & Media",
            content: `
                <ul>
                    <li>Books, podcasts, reels, and series advancing structural psychology and civilization studies.</li>
                    
                </ul>
            `
        },
        research: {
            title: "CRIPFCnt DNA Placement Campaign",
            content: `
                <ul>
                    <li> Identity and origin audits linking biological truth with structural placement.</li>
                    
                </ul>
            `
        },
        policy: {
            title: "CRIPFCnt Technology Integration",
            content: `
                <ul>
                    <li>Development of digital placement tools and AI-aligned recalibration engines.</li>
                  
                </ul>
            `
        },
    
    };

    // Add Bootstrap modal HTML to body only if it doesn't already exist
    if ($('#serviceModal').length === 0) {
        $('body').append(`
            <div class="modal fade" id="serviceModal" tabindex="-1" aria-labelledby="serviceModalLabel" aria-hidden="true">
                <div class="modal-dialog modal-dialog-centered modal-lg">
                    <div class="modal-content">
                        <div class="modal-header">
                            <h5 class="modal-title" id="serviceModalLabel"></h5>
                            <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
                        </div>
                        <div class="modal-body"></div>
                    </div>
                </div>
            </div>
        `);
    }

    const $modal = $('#serviceModal');
    const modal = new bootstrap.Modal($modal[0]);

    // Open modal when clicking a service item
    $('.service-item').on('click', function() {
        const serviceId = $(this).data('service');
        console.log('Service clicked:', serviceId);
        
        const service = serviceDetails[serviceId];
        console.log('Service data:', service);
        
        if (service) {
            $('#serviceModalLabel').text(service.title);
            $('.modal-body').html(service.content);
            console.log('Modal content set:', {
                title: service.title,
                content: service.content
            });
            
            modal.show();

            // Add entrance animation for list items if present
            $('.modal-body').find('li').each(function(index) {
                $(this)
                    .css({
                        opacity: 0,
                        transform: 'translateY(20px)'
                    })
                    .delay(100 + (index * 50))
                    .queue(function(next) {
                        $(this).css({
                            transition: 'all 0.3s ease',
                            opacity: 1,
                            transform: 'translateY(0)'
                        });
                        next();
                    });
            });
        } else {
            console.error('Service not found:', serviceId);
        }
    });

    // Handle modal close with escape key and clicking outside
    $modal.on('hidden.bs.modal', function () {
        $('body').css('overflow', 'auto');
    });
});